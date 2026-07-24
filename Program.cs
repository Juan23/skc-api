using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Dapper;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection");

// The API's own published port is bound to a specific host IP (100.84.79.35), not
// 0.0.0.0/127.0.0.1 - so a `tailscale serve` reverse proxy running on the droplet
// itself (needed for HTTPS, see webapp-pos-plan.md Increment 0) connects to the
// container over that same address, and that's the RemoteIpAddress the container
// sees for every proxied request (confirmed empirically via tcpdump - Docker does
// NOT rewrite it to the bridge gateway IP here, unlike typical hairpin-NAT setups).
// Trusting exactly that one address as the sole known proxy - never a broader
// network/loopback range - means only tailscale serve running on this host can
// ever supply a trusted X-Forwarded-For; no tailnet peer can spoof it, since they
// can't make a packet appear to originate from the droplet's own address over
// Tailscale's WireGuard fabric. This also means every existing IsTrustedOfficeIp/
// IsOwnerIp/IsTrustedBranchIp check below needs zero code changes: the middleware
// rewrites HttpContext.Connection.RemoteIpAddress in place before those run.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor;
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
    options.KnownProxies.Add(IPAddress.Parse("100.84.79.35"));
});

var app = builder.Build();

// Must run before every other middleware/endpoint - see the KnownProxies comment above.
app.UseForwardedHeaders();

// Office/owner/branch IP allowlists. Tailscale assigns each device on the tailnet a stable 100.x
// address, so checking the caller's remote IP is a real server-side restriction rather than
// trusting whoever has a copy of the client exe. These used to be hardcoded HashSet/Dictionary
// literals here; since migration 011 they live in the app_devices table, which the owner edits
// from the webapp (POST/PUT/PATCH/DELETE /api/devices) instead of a code change + redeploy.
// deviceRegistry (defined near the file bottom) caches an in-process snapshot of the active rows
// so these gates - which run on every request - don't hit Postgres each time; a write endpoint
// calls deviceRegistry.Invalidate() so an edit takes effect on the very next request.
//
// The snapshot applies a tier hierarchy that reproduces the old overlapping sets exactly:
//   Owner-tier device  -> satisfies owner + office + every branch check
//   Office-tier device -> satisfies office
//   Branch-tier device -> satisfies only its own branch
// A branch with no Branch-tier row is absent from the snapshot's branch map, so IsTrustedBranchIp
// FAILS OPEN for it (unchanged) - most branches aren't on Tailscale yet and would otherwise break.
var deviceRegistry = new DeviceRegistry(connectionString!);

// Break-glass: the owner's own physical devices are ALSO trusted for owner checks in code, so an
// empty/typo'd/all-deactivated app_devices table (or a DB blip that yields an empty snapshot) can
// never lock the owner out of /api/devices or /api/users - they can always sign in from a known
// device and repair the registry. Scoped to owner only (correct blast radius). Update this list by
// hand if the owner's personal devices ever change. (These are the same three IPs migration 011 seeds.)
var emergencyOwnerIps = new HashSet<string> { "100.108.218.24", "100.81.94.66", "100.69.186.113" };

// ForwardedHeaders already rewrote RemoteIpAddress to the real tailnet caller (see top of file).
string? NormalizedIp(HttpContext http)
{
    var ip = http.Connection.RemoteIpAddress;
    if (ip == null) return null;
    if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
    return ip.ToString();
}

bool IsTrustedOfficeIp(HttpContext http)
{
    var ip = NormalizedIp(http);
    if (ip == null) return false;
    return deviceRegistry.Current().OfficeIps.Contains(ip);
}

bool IsOwnerIp(HttpContext http)
{
    var ip = NormalizedIp(http);
    if (ip == null) return false;
    return deviceRegistry.Current().OwnerIps.Contains(ip) || emergencyOwnerIps.Contains(ip);
}

bool IsTrustedBranchIp(string branch, HttpContext http)
{
    var snapshot = deviceRegistry.Current();
    if (!snapshot.BranchIps.TryGetValue(branch, out var allowed)) return true;   // FAIL-OPEN, unchanged
    var ip = NormalizedIp(http);
    if (ip == null) return false;
    return allowed.Contains(ip);
}

// ---------------------------------------------------------------------------
// Webapp authentication (added 2026-07-20). WinForms clients send no cookie and
// therefore keep hitting the three IP checks above, byte-for-byte as before.
// ---------------------------------------------------------------------------

const string SessionCookieName = "skc_session";
const int SessionHours = 12;                     // one work day, absolute (no sliding renewal)
const int PbkdfIterations = 100_000;
const int MinPasswordLength = 8;

// Self-describing hash string (PBKDF2-SHA256$iters$saltB64$hashB64) so the
// iteration count can be raised later without invalidating existing rows.
// No new NuGet dependency - Rfc2898DeriveBytes is in the BCL.
string HashPassword(string password)
{
    byte[] salt = RandomNumberGenerator.GetBytes(16);
    byte[] hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, PbkdfIterations, HashAlgorithmName.SHA256, 32);
    return $"PBKDF2-SHA256${PbkdfIterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
}

// Returns false for anything that isn't a well-formed hash of this shape, which
// is what makes the seeded '!' sentinel permanently unverifiable rather than a
// password someone could guess.
bool VerifyPassword(string password, string stored)
{
    var parts = stored.Split('$');
    if (parts.Length != 4 || parts[0] != "PBKDF2-SHA256") return false;
    if (!int.TryParse(parts[1], out int iterations) || iterations <= 0) return false;
    try
    {
        byte[] salt = Convert.FromBase64String(parts[2]);
        byte[] expected = Convert.FromBase64String(parts[3]);
        byte[] actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
    catch (FormatException) { return false; }
}

string Sha256Hex(string value) =>
    Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

SessionUser? CurrentSession(HttpContext http) =>
    http.Items.TryGetValue("session", out var s) ? s as SessionUser : null;

// The three gates below keep their original names and every call site, so the
// 14 already-gated endpoints have a zero-line diff. Cookie-less request (any
// WinForms app, or curl) -> the old IP check verbatim. Session present -> the
// role must fit AND the same IP check must still pass; the Owner role satisfies
// all three role checks but is still bound by the IP layer, so the owner logged
// in on the office PC genuinely cannot do owner-only work. Note the branch gate
// gets strictly tighter than it was: a session for one branch can't write to
// another even when that branch is absent from branchIps (fail-open on IP).
bool IsTrustedOfficeCaller(HttpContext http)
{
    var session = CurrentSession(http);
    if (session == null) return IsTrustedOfficeIp(http);
    return (session.Role == "Owner" || session.Role == "Office") && IsTrustedOfficeIp(http);
}

bool IsOwnerCaller(HttpContext http)
{
    var session = CurrentSession(http);
    if (session == null) return IsOwnerIp(http);
    return session.Role == "Owner" && IsOwnerIp(http);
}

bool IsTrustedBranchCaller(string branch, HttpContext http)
{
    var session = CurrentSession(http);
    if (session == null) return IsTrustedBranchIp(branch, http);
    if (session.Role == "Owner") return IsTrustedBranchIp(branch, http);
    if (session.Role != "Branch") return false;
    if (!string.Equals(session.BranchName, branch, StringComparison.OrdinalIgnoreCase)) return false;
    return IsTrustedBranchIp(branch, http);
}

// Read gate for branch-scoped history that carries owner-confidential cost/revenue/staff data - the
// /api/sales GETs, /api/production, /api/deliveries/pending, and (via its ticket's DB to_branch)
// /api/deliveries/{id}. Readable by the office/owner (any branch - the office reports and the webapp
// office/owner screens legitimately span all branches) OR by a branch's own trusted devices (its own
// branch only) - never by one onboarded branch reading another's. Same fail-open posture as the write
// gates: a branch absent from branchIps stays ungated (Gaisano/Liloy/Labason keep working). Added
// 2026-07-22 for the cost/margin GET-exposure item in /bug-track.md. Office/owner callers run from
// trusted office/owner IPs so they're unaffected; the one behaviour change is that an Office/Owner-
// role session from an *untrusted* IP can no longer read this data - matching how office *writes*
// are already IP-gated (both layers required). The office-ONLY cost views (purchases, delivery
// tickets/daily, adjustments) use IsTrustedOfficeCaller directly instead - no branch ever reads them.
bool CanReadBranchScoped(string branch, HttpContext http) =>
    IsTrustedOfficeCaller(http) || IsTrustedBranchCaller(branch, http);

// Serve the built SPA (skc-api/webapp -> wwwroot) when it's present. Absent in a
// bare source checkout, hence the guard - the API still runs API-only.
if (Directory.Exists(Path.Combine(app.Environment.ContentRootPath, "wwwroot")))
{
    app.UseDefaultFiles();
    app.UseStaticFiles(new StaticFileOptions
    {
        OnPrepareResponse = ctx =>
        {
            // sw.js/registerSW.js/manifest.webmanifest are NOT content-hashed
            // (unlike /assets/*.js) - the default static-file response only
            // carries an ETag, which lets a browser skip revalidation inside
            // its own heuristic freshness window instead of always asking.
            // A stale cached service worker is the classic PWA deploy bug,
            // so force revalidation on every request for exactly these.
            var name = Path.GetFileName(ctx.File.Name);
            if (name is "sw.js" or "registerSW.js" or "manifest.webmanifest")
            {
                ctx.Context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
            }
        }
    });
}

// Session middleware. Must run before the endpoints so the gate wrappers above
// can see HttpContext.Items["session"].
app.Use(async (http, next) =>
{
    var token = http.Request.Cookies[SessionCookieName];
    if (string.IsNullOrEmpty(token)) { await next(); return; }   // WinForms path: not even a DB round-trip

    using var authDb = new NpgsqlConnection(connectionString);
    await authDb.OpenAsync();
    // Explicit aliases, not bare snake_case: Dapper's underscore matching is an
    // opt-in static flag that this project doesn't set, so `user_id` would map
    // to nothing and hand back a session with UserId = 0 and Role = null.
    var session = await authDb.QuerySingleOrDefaultAsync<SessionUser>(@"
        SELECT u.user_id AS UserId, u.username AS Username, u.role AS Role,
               u.branch_name AS BranchName, u.must_change_password AS MustChangePassword
        FROM app_sessions s
        JOIN app_users u ON u.user_id = s.user_id
        WHERE s.token_hash = @TokenHash
          AND s.expires_at > CURRENT_TIMESTAMP
          AND u.is_active", new { TokenHash = Sha256Hex(token) });

    if (session != null)
    {
        http.Items["session"] = session;
        await next();
        return;
    }

    // Expired, tampered, logged-out or deactivated. Deliberately a 401 rather
    // than falling through to the IP-only path: silently downgrading would let
    // a stale cookie on a trusted PC keep writing as if it were WinForms.
    // /api/auth/* is exempt so login (and logout of a dead session) still works.
    if (http.Request.Path.StartsWithSegments("/api") && !http.Request.Path.StartsWithSegments("/api/auth"))
    {
        http.Response.Cookies.Delete(SessionCookieName, new CookieOptions { Path = "/" });
        http.Response.StatusCode = 401;
        await http.Response.WriteAsJsonAsync(new { error = "Your session has expired. Please sign in again." });
        return;
    }
    await next();
});

// Shared validation for recipe create/update. Kind mirrors the DB's chk_recipe_kind
// constraint; a recipe needs at least one output (its menu of possible finished goods),
// each with a positive weight and a distinct SKU, and every input line a positive qty -
// so a bad value gets a clean 400 instead of a raw Postgres constraint-violation message.
string? ValidateRecipeDto(RecipeDto dto)
{
    if (dto.Kind != "Baking" && dto.Kind != "Decorating")
        return "Kind must be Baking or Decorating.";
    if (dto.Outputs == null || dto.Outputs.Count == 0)
        return "A recipe needs at least one possible output.";
    if (dto.Outputs.Any(o => string.IsNullOrWhiteSpace(o.OutputSku)))
        return "Every output needs a product.";
    if (dto.Outputs.Any(o => o.Weight <= 0))
        return "Every output's weight must be greater than zero.";
    if (dto.Outputs.Select(o => o.OutputSku).Distinct(StringComparer.OrdinalIgnoreCase).Count() != dto.Outputs.Count)
        return "The same output product is listed twice.";
    if (dto.Lines.Any(l => l.Qty <= 0))
        return "Each recipe line's Qty must be greater than zero.";
    return null;
}

// Endpoints
app.MapGet("/health", () => Results.Ok(new { Status = "Healthy" }));

// ---------------------------------------------------------------------------
// Auth endpoints. These are the only ones exempt from the middleware's
// stale-cookie 401, so a user holding a dead cookie can still log back in.
// ---------------------------------------------------------------------------

// Mints a token, stores only its hash, and sets the cookie. Secure flag added
// 2026-07-21 alongside the `tailscale serve` HTTPS cutover (webapp-pos-plan.md
// Increment 0) - from this deploy on, webapp login only works from the HTTPS
// *.ts.net origin; a browser silently drops a Secure cookie set over plain HTTP.
// WinForms clients are unaffected - they never send this cookie at all.
// SameSite=Strict is what makes CSRF a non-issue: the browser omits the cookie
// on every cross-site request, and no CORS policy exists for a fetch to use.
async Task IssueSessionAsync(NpgsqlConnection db, int userId, HttpContext http)
{
    var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    await db.ExecuteAsync(@"
        INSERT INTO app_sessions (token_hash, user_id, expires_at)
        VALUES (@TokenHash, @UserId, CURRENT_TIMESTAMP + make_interval(hours => @Hours))",
        new { TokenHash = Sha256Hex(token), UserId = userId, Hours = SessionHours });

    http.Response.Cookies.Append(SessionCookieName, token, new CookieOptions
    {
        HttpOnly = true,
        Secure = true,
        SameSite = SameSiteMode.Strict,
        Path = "/",
        MaxAge = TimeSpan.FromHours(SessionHours)
    });
}

// Is the owner account still sitting on the seeded sentinel hash? Drives the
// first-run setup screen. Ungated - it leaks nothing an attacker on the tailnet
// couldn't learn by trying to log in.
app.MapGet("/api/auth/setup-needed", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    var hash = await db.ExecuteScalarAsync<string?>(
        "SELECT password_hash FROM app_users WHERE LOWER(username) = 'owner'");
    return Results.Ok(new { Needed = hash == "!" });
});

// First run only: the owner sets their own password from an owner device, so no
// plaintext ever lives in the migration or in a chat log. 409 forever after.
app.MapPost("/api/auth/bootstrap", async (BootstrapDto dto, HttpContext http) =>
{
    if (!IsOwnerIp(http)) return Results.Problem("This endpoint is restricted to the owner's device.", statusCode: 403);
    if (dto.Password == null || dto.Password.Length < MinPasswordLength)
        return Results.BadRequest($"Password must be at least {MinPasswordLength} characters.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    // WHERE password_hash = '!' makes this atomic: a second concurrent call
    // updates zero rows and gets the 409 rather than overwriting the first.
    var userId = await db.ExecuteScalarAsync<int?>(@"
        UPDATE app_users SET password_hash = @Hash, must_change_password = FALSE
        WHERE LOWER(username) = 'owner' AND password_hash = '!'
        RETURNING user_id", new { Hash = HashPassword(dto.Password) });

    if (userId == null) return Results.Problem("The owner password has already been set.", statusCode: 409);

    await IssueSessionAsync(db, userId.Value, http);
    return Results.Ok(new { Status = "Ready" });
});

// Naive per-IP limiter, same idiom as the website's feedback endpoint. In-memory
// by design: a restart clearing it is harmless on a single-instance tailnet API.
var loginAttempts = new ConcurrentDictionary<string, (DateTime WindowStart, int Count)>();

app.MapPost("/api/auth/login", async (LoginDto dto, HttpContext http) =>
{
    var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    var now = DateTime.UtcNow;
    var attempts = loginAttempts.AddOrUpdate(ip,
        _ => (now, 1),
        (_, cur) => now - cur.WindowStart > TimeSpan.FromMinutes(5) ? (now, 1) : (cur.WindowStart, cur.Count + 1));
    // 50, not 10 (bumped 2026-07-24): a full Playwright suite run costs ~9 logins
    // from one IP, so 10 made back-to-back runs 429 - pure friction, since the
    // only callers are already inside the tailnet AND device-gated. 50/5min still
    // caps credential guessing at a rate that goes nowhere against real passwords.
    if (attempts.Count > 50) return Results.StatusCode(429);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var user = await db.QuerySingleOrDefaultAsync<AppUserRow>(
        @"SELECT user_id AS UserId, username AS Username, password_hash AS PasswordHash, role AS Role,
                 branch_name AS BranchName, is_active AS IsActive, must_change_password AS MustChangePassword
          FROM app_users WHERE LOWER(username) = LOWER(@Username)",
        new { dto.Username });

    // One generic message for every failure mode - wrong user, wrong password,
    // deactivated account - so the form can't be used to enumerate accounts.
    // The hash is still verified against a dummy when the user doesn't exist so
    // a missing username isn't detectable by response time.
    var stored = user?.PasswordHash ?? "PBKDF2-SHA256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    bool ok = VerifyPassword(dto.Password ?? "", stored) && user != null && user.IsActive;
    if (!ok) return Results.Problem("Incorrect username or password.", statusCode: 401);

    // Cheap housekeeping while we're already connected - no separate sweeper.
    await db.ExecuteAsync("DELETE FROM app_sessions WHERE expires_at <= CURRENT_TIMESTAMP");

    await IssueSessionAsync(db, user!.UserId, http);
    return Results.Ok(new
    {
        user.Username,
        user.Role,
        user.BranchName,
        user.MustChangePassword
    });
});

app.MapPost("/api/auth/logout", async (HttpContext http) =>
{
    var token = http.Request.Cookies[SessionCookieName];
    if (!string.IsNullOrEmpty(token))
    {
        using var db = new NpgsqlConnection(connectionString);
        await db.ExecuteAsync("DELETE FROM app_sessions WHERE token_hash = @TokenHash",
            new { TokenHash = Sha256Hex(token) });
    }
    http.Response.Cookies.Delete(SessionCookieName, new CookieOptions { Path = "/" });
    return Results.Ok(new { Status = "SignedOut" });
});

app.MapGet("/api/auth/me", (HttpContext http) =>
{
    var session = CurrentSession(http);
    if (session == null) return Results.Problem("Not signed in.", statusCode: 401);
    return Results.Ok(new
    {
        session.Username,
        session.Role,
        session.BranchName,
        session.MustChangePassword
    });
});

app.MapPost("/api/auth/change-password", async (ChangePasswordDto dto, HttpContext http) =>
{
    var session = CurrentSession(http);
    if (session == null) return Results.Problem("Not signed in.", statusCode: 401);
    if (dto.NewPassword == null || dto.NewPassword.Length < MinPasswordLength)
        return Results.BadRequest($"New password must be at least {MinPasswordLength} characters.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var stored = await db.ExecuteScalarAsync<string>(
        "SELECT password_hash FROM app_users WHERE user_id = @UserId", new { session.UserId });
    if (stored == null || !VerifyPassword(dto.CurrentPassword ?? "", stored))
        return Results.Problem("Current password is incorrect.", statusCode: 403);

    await db.ExecuteAsync(
        "UPDATE app_users SET password_hash = @Hash, must_change_password = FALSE WHERE user_id = @UserId",
        new { Hash = HashPassword(dto.NewPassword), session.UserId });

    // Sign out this user's other devices - a password change should evict
    // whoever might have been using the old one. The current cookie survives.
    await db.ExecuteAsync(
        "DELETE FROM app_sessions WHERE user_id = @UserId AND token_hash <> @TokenHash",
        new { session.UserId, TokenHash = Sha256Hex(http.Request.Cookies[SessionCookieName] ?? "") });

    return Results.Ok(new { Status = "Changed" });
});

// ---------------------------------------------------------------------------
// User management - Owner role AND an owner device, both required. Unlike the
// other gates there's no cookie-less fallback: WinForms has no notion of users,
// so an unauthenticated caller gets 401 rather than the legacy IP-only path.
// ---------------------------------------------------------------------------
IResult? RequireOwnerAdmin(HttpContext http)
{
    var session = CurrentSession(http);
    if (session == null) return Results.Problem("Sign in as the owner to manage users.", statusCode: 401);
    if (session.Role != "Owner" || !IsOwnerIp(http))
        return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    return null;
}

string? ValidateUserDto(string? username, string role, string? branchName)
{
    if (username != null && (username.Trim().Length < 3 || username.Trim().Length > 64))
        return "Username must be 3-64 characters.";
    if (role != "Owner" && role != "Office" && role != "Branch")
        return "Role must be Owner, Office or Branch.";
    if (role == "Branch" && string.IsNullOrWhiteSpace(branchName))
        return "A Branch user must be tied to a branch.";
    return null;
}

// Would this change leave nobody able to administer users? Counts active Owners
// other than the one being changed.
async Task<bool> WouldOrphanOwnersAsync(NpgsqlConnection db, int excludedUserId)
{
    int others = await db.ExecuteScalarAsync<int>(
        "SELECT COUNT(*) FROM app_users WHERE role = 'Owner' AND is_active AND user_id <> @UserId",
        new { UserId = excludedUserId });
    return others == 0;
}

app.MapGet("/api/users", async (HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<AppUserListRow>(@"
        SELECT user_id AS UserId, username AS Username, role AS Role, branch_name AS BranchName,
               is_active AS IsActive, must_change_password AS MustChangePassword, created_at AS CreatedAt
        FROM app_users ORDER BY role, LOWER(username)"));
});

app.MapPost("/api/users", async (CreateUserDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateUserDto(dto.Username, dto.Role, dto.BranchName);
    if (invalid != null) return Results.BadRequest(invalid);
    if (dto.Password == null || dto.Password.Length < MinPasswordLength)
        return Results.BadRequest($"Password must be at least {MinPasswordLength} characters.");

    using var db = new NpgsqlConnection(connectionString);
    try
    {
        // New accounts always start needing a password change, so the owner
        // never keeps knowing a staff member's working password.
        int id = await db.ExecuteScalarAsync<int>(@"
            INSERT INTO app_users (username, password_hash, role, branch_name, must_change_password)
            VALUES (@Username, @Hash, @Role, @BranchName, TRUE)
            RETURNING user_id",
            new
            {
                Username = dto.Username!.Trim(),
                Hash = HashPassword(dto.Password),
                dto.Role,
                BranchName = dto.Role == "Branch" ? dto.BranchName!.Trim() : null
            });
        return Results.Ok(new { UserId = id });
    }
    catch (PostgresException ex) when (ex.SqlState == "23505")
    {
        return Results.Problem($"A user named '{dto.Username!.Trim()}' already exists.", statusCode: 409);
    }
});

app.MapPut("/api/users/{id:int}", async (int id, UpdateUserDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateUserDto(null, dto.Role, dto.BranchName);
    if (invalid != null) return Results.BadRequest(invalid);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var current = await db.QuerySingleOrDefaultAsync<AppUserListRow>(
        @"SELECT user_id AS UserId, username AS Username, role AS Role, branch_name AS BranchName,
                 is_active AS IsActive, must_change_password AS MustChangePassword, created_at AS CreatedAt
          FROM app_users WHERE user_id = @id", new { id });
    if (current == null) return Results.NotFound($"No user {id}.");
    if (current.Role == "Owner" && dto.Role != "Owner" && current.IsActive && await WouldOrphanOwnersAsync(db, id))
        return Results.BadRequest("This is the last active Owner - demoting it would lock everyone out of user management.");

    await db.ExecuteAsync(
        "UPDATE app_users SET role = @Role, branch_name = @BranchName WHERE user_id = @id",
        new { dto.Role, BranchName = dto.Role == "Branch" ? dto.BranchName!.Trim() : null, id });
    return Results.Ok(new { Status = "Updated" });
});

app.MapPost("/api/users/{id:int}/reset-password", async (int id, ResetPasswordDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    if (dto.NewPassword == null || dto.NewPassword.Length < MinPasswordLength)
        return Results.BadRequest($"Password must be at least {MinPasswordLength} characters.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    int rows = await db.ExecuteAsync(
        "UPDATE app_users SET password_hash = @Hash, must_change_password = TRUE WHERE user_id = @id",
        new { Hash = HashPassword(dto.NewPassword), id });
    if (rows == 0) return Results.NotFound($"No user {id}.");

    // Kick every session of the reset account - the point of a reset is usually
    // that someone shouldn't still be signed in.
    await db.ExecuteAsync("DELETE FROM app_sessions WHERE user_id = @id", new { id });
    return Results.Ok(new { Status = "Reset" });
});

app.MapPatch("/api/users/{id:int}/deactivate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var role = await db.ExecuteScalarAsync<string?>("SELECT role FROM app_users WHERE user_id = @id", new { id });
    if (role == null) return Results.NotFound($"No user {id}.");
    if (role == "Owner" && await WouldOrphanOwnersAsync(db, id))
        return Results.BadRequest("This is the last active Owner - deactivating it would lock everyone out of user management.");

    await db.ExecuteAsync("UPDATE app_users SET is_active = FALSE WHERE user_id = @id", new { id });
    await db.ExecuteAsync("DELETE FROM app_sessions WHERE user_id = @id", new { id });
    return Results.Ok(new { Status = "Deactivated" });
});

app.MapPatch("/api/users/{id:int}/activate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE app_users SET is_active = TRUE WHERE user_id = @id", new { id });
    return rows == 0 ? Results.NotFound($"No user {id}.") : Results.Ok(new { Status = "Activated" });
});

// ---------------------------------------------------------------------------
// Device -> tier registry management (migration 011). Same owner-only trust as
// user management: RequireOwnerAdmin (Owner role AND owner IP, no cookie-less
// fallback). Every write calls deviceRegistry.Invalidate() so the change applies
// on the very next request rather than after the 30s cache TTL.
// ---------------------------------------------------------------------------
string? ValidateDeviceDto(string? tailscaleIp, string tier, string? branchName, out string normalizedIp)
{
    normalizedIp = "";
    if (string.IsNullOrWhiteSpace(tailscaleIp) || !IPAddress.TryParse(tailscaleIp.Trim(), out var parsed))
        return "A valid IP address is required.";
    if (parsed.IsIPv4MappedToIPv6) parsed = parsed.MapToIPv4();
    normalizedIp = parsed.ToString();   // store canonical form so it matches the normalized RemoteIpAddress
    if (tier != "Owner" && tier != "Office" && tier != "Branch")
        return "Tier must be Owner, Office or Branch.";
    if (tier == "Branch" && string.IsNullOrWhiteSpace(branchName))
        return "A Branch device must be tied to a branch.";
    return null;
}

// The hardcoded emergencyOwnerIps mean the owner is never truly locked out, but
// this guard stops the owner accidentally emptying the owner tier and stranding a
// non-emergency owner device - mirrors WouldOrphanOwnersAsync for user management.
async Task<bool> WouldOrphanOwnerDevicesAsync(NpgsqlConnection db, int excludedDeviceId)
{
    int others = await db.ExecuteScalarAsync<int>(
        "SELECT COUNT(*) FROM app_devices WHERE tier = 'Owner' AND is_active AND device_id <> @DeviceId",
        new { DeviceId = excludedDeviceId });
    return others == 0;
}

app.MapGet("/api/devices", async (HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<AppDeviceRow>(@"
        SELECT device_id AS DeviceId, tailscale_ip AS TailscaleIp, tier AS Tier, branch_name AS BranchName,
               label AS Label, is_active AS IsActive, created_at AS CreatedAt
        FROM app_devices ORDER BY tier, branch_name NULLS FIRST, tailscale_ip"));
});

app.MapPost("/api/devices", async (CreateDeviceDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateDeviceDto(dto.TailscaleIp, dto.Tier, dto.BranchName, out var ip);
    if (invalid != null) return Results.BadRequest(invalid);

    using var db = new NpgsqlConnection(connectionString);
    try
    {
        int id = await db.ExecuteScalarAsync<int>(@"
            INSERT INTO app_devices (tailscale_ip, tier, branch_name, label)
            VALUES (@Ip, @Tier, @BranchName, @Label)
            RETURNING device_id",
            new
            {
                Ip = ip,
                dto.Tier,
                BranchName = dto.Tier == "Branch" ? dto.BranchName!.Trim() : null,
                Label = string.IsNullOrWhiteSpace(dto.Label) ? null : dto.Label!.Trim()
            });
        deviceRegistry.Invalidate();
        return Results.Ok(new { DeviceId = id });
    }
    catch (PostgresException ex) when (ex.SqlState == "23505")
    {
        return Results.Problem($"A device with IP '{ip}' already exists.", statusCode: 409);
    }
});

app.MapPut("/api/devices/{id:int}", async (int id, UpdateDeviceDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateDeviceDto(dto.TailscaleIp, dto.Tier, dto.BranchName, out var ip);
    if (invalid != null) return Results.BadRequest(invalid);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var current = await db.QuerySingleOrDefaultAsync<AppDeviceRow>(
        @"SELECT device_id AS DeviceId, tailscale_ip AS TailscaleIp, tier AS Tier, branch_name AS BranchName,
                 label AS Label, is_active AS IsActive, created_at AS CreatedAt
          FROM app_devices WHERE device_id = @id", new { id });
    if (current == null) return Results.NotFound($"No device {id}.");
    if (current.Tier == "Owner" && dto.Tier != "Owner" && current.IsActive && await WouldOrphanOwnerDevicesAsync(db, id))
        return Results.BadRequest("This is the last active owner device - changing its tier could lock the owner out of device management.");

    try
    {
        await db.ExecuteAsync(@"
            UPDATE app_devices SET tailscale_ip = @Ip, tier = @Tier, branch_name = @BranchName, label = @Label
            WHERE device_id = @id",
            new
            {
                Ip = ip,
                dto.Tier,
                BranchName = dto.Tier == "Branch" ? dto.BranchName!.Trim() : null,
                Label = string.IsNullOrWhiteSpace(dto.Label) ? null : dto.Label!.Trim(),
                id
            });
        deviceRegistry.Invalidate();
        return Results.Ok(new { Status = "Updated" });
    }
    catch (PostgresException ex) when (ex.SqlState == "23505")
    {
        return Results.Problem($"A device with IP '{ip}' already exists.", statusCode: 409);
    }
});

app.MapPatch("/api/devices/{id:int}/deactivate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var tier = await db.ExecuteScalarAsync<string?>("SELECT tier FROM app_devices WHERE device_id = @id", new { id });
    if (tier == null) return Results.NotFound($"No device {id}.");
    if (tier == "Owner" && await WouldOrphanOwnerDevicesAsync(db, id))
        return Results.BadRequest("This is the last active owner device - deactivating it could lock the owner out of device management.");

    await db.ExecuteAsync("UPDATE app_devices SET is_active = FALSE WHERE device_id = @id", new { id });
    deviceRegistry.Invalidate();
    return Results.Ok(new { Status = "Deactivated" });
});

app.MapPatch("/api/devices/{id:int}/activate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE app_devices SET is_active = TRUE WHERE device_id = @id", new { id });
    if (rows == 0) return Results.NotFound($"No device {id}.");
    deviceRegistry.Invalidate();
    return Results.Ok(new { Status = "Activated" });
});

app.MapDelete("/api/devices/{id:int}", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    var device = await db.QuerySingleOrDefaultAsync<AppDeviceRow>(
        @"SELECT device_id AS DeviceId, tailscale_ip AS TailscaleIp, tier AS Tier, branch_name AS BranchName,
                 label AS Label, is_active AS IsActive, created_at AS CreatedAt
          FROM app_devices WHERE device_id = @id", new { id });
    if (device == null) return Results.NotFound($"No device {id}.");
    if (device.Tier == "Owner" && device.IsActive && await WouldOrphanOwnerDevicesAsync(db, id))
        return Results.BadRequest("This is the last active owner device - deleting it could lock the owner out of device management.");

    await db.ExecuteAsync("DELETE FROM app_devices WHERE device_id = @id", new { id });
    deviceRegistry.Invalidate();
    return Results.Ok(new { Status = "Deleted" });
});

// ---------------------------------------------------------------------------
// POS cashier registry - backs the web POS cashier picker. Admin endpoints are
// RequireOwnerAdmin like devices/users; the per-branch feed is an ungated GET
// (like every other GET) and deliberately includes each cashier's PIN salt+hash
// so tills can cache them in IndexedDB and verify PINs offline. That makes the
// PIN accountability-grade, not security-grade: 4 digits against a cached hash
// is brute-forceable by design - its job is honest sale attribution, not access
// control. Also deliberately absent, with reasons:
//  - No orphan guard: zero cashiers for a branch is not a lockout - its tills
//    fall back to the free-text staff-name input (that IS the rollback path).
//  - No advisory lock/transaction: single-statement writes, and pos_staff isn't
//    part of the shared MAX(local_id) ID-assignment pattern.
//  - No lockout counter on wrong PINs: verification happens client-side on an
//    offline device; any lockout would just brick a till mid-shift.
// ---------------------------------------------------------------------------
string? ValidateStaffDto(string? branchName, string? staffName)
{
    if (string.IsNullOrWhiteSpace(branchName) || branchName.Trim().Length > 100)
        return "A branch name is required (max 100 characters).";
    if (string.IsNullOrWhiteSpace(staffName) || staffName.Trim().Length < 2 || staffName.Trim().Length > 100)
        return "Staff name must be 2-100 characters.";
    return null;
}

string? ValidatePin(string? pin) =>
    pin != null && pin.Length == 4 && pin.All(char.IsAsciiDigit) ? null : "PIN must be exactly 4 digits.";

// Scheme (canonical here and in the till's Web Crypto check): salt = 16 random
// bytes as lowercase hex; hash = lowercase hex SHA-256(UTF8(salt + pin)).
(string Salt, string Hash) HashPin(string pin)
{
    var salt = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
    return (salt, Sha256Hex(salt + pin));
}

// The till feed: active cashiers for one branch, WITH pin material (see the
// block comment above). Typed QueryAsync so the aliased columns map camelCase.
app.MapGet("/api/staff/branch/{branch}", async (string branch) =>
{
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<PosStaffPublicRow>(@"
        SELECT staff_id AS StaffId, staff_name AS StaffName, pin_salt AS PinSalt, pin_hash AS PinHash
        FROM pos_staff WHERE branch_name = @branch AND is_active
        ORDER BY LOWER(staff_name)", new { branch }));
});

app.MapGet("/api/staff", async (HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<PosStaffRow>(@"
        SELECT staff_id AS StaffId, branch_name AS BranchName, staff_name AS StaffName,
               is_active AS IsActive, created_at AS CreatedAt
        FROM pos_staff ORDER BY branch_name, LOWER(staff_name)"));
});

app.MapPost("/api/staff", async (CreateStaffDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateStaffDto(dto.BranchName, dto.StaffName) ?? ValidatePin(dto.Pin);
    if (invalid != null) return Results.BadRequest(invalid);

    var (salt, hash) = HashPin(dto.Pin!);
    using var db = new NpgsqlConnection(connectionString);
    try
    {
        int id = await db.ExecuteScalarAsync<int>(@"
            INSERT INTO pos_staff (branch_name, staff_name, pin_salt, pin_hash)
            VALUES (@BranchName, @StaffName, @Salt, @Hash)
            RETURNING staff_id",
            new { BranchName = dto.BranchName!.Trim(), StaffName = dto.StaffName!.Trim(), Salt = salt, Hash = hash });
        return Results.Ok(new { StaffId = id });
    }
    catch (PostgresException ex) when (ex.SqlState == "23505")
    {
        return Results.Problem($"A staff member named '{dto.StaffName!.Trim()}' already exists for {dto.BranchName!.Trim()}.", statusCode: 409);
    }
});

// Rename / move branch only - the PIN is untouched (reset it via /pin below).
app.MapPut("/api/staff/{id:int}", async (int id, UpdateStaffDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidateStaffDto(dto.BranchName, dto.StaffName);
    if (invalid != null) return Results.BadRequest(invalid);

    using var db = new NpgsqlConnection(connectionString);
    try
    {
        int rows = await db.ExecuteAsync(@"
            UPDATE pos_staff SET branch_name = @BranchName, staff_name = @StaffName WHERE staff_id = @id",
            new { BranchName = dto.BranchName!.Trim(), StaffName = dto.StaffName!.Trim(), id });
        if (rows == 0) return Results.NotFound($"No staff member {id}.");
        return Results.Ok(new { Status = "Updated" });
    }
    catch (PostgresException ex) when (ex.SqlState == "23505")
    {
        return Results.Problem($"A staff member named '{dto.StaffName!.Trim()}' already exists for {dto.BranchName!.Trim()}.", statusCode: 409);
    }
});

// The plaintext PIN crosses the wire (HTTPS only), is hashed immediately with a
// fresh salt, and is never stored or logged.
app.MapPost("/api/staff/{id:int}/pin", async (int id, SetStaffPinDto dto, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    var invalid = ValidatePin(dto.Pin);
    if (invalid != null) return Results.BadRequest(invalid);

    var (salt, hash) = HashPin(dto.Pin!);
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE pos_staff SET pin_salt = @Salt, pin_hash = @Hash WHERE staff_id = @id",
        new { Salt = salt, Hash = hash, id });
    if (rows == 0) return Results.NotFound($"No staff member {id}.");
    return Results.Ok(new { Status = "PinSet" });
});

app.MapPatch("/api/staff/{id:int}/deactivate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE pos_staff SET is_active = FALSE WHERE staff_id = @id", new { id });
    if (rows == 0) return Results.NotFound($"No staff member {id}.");
    return Results.Ok(new { Status = "Deactivated" });
});

app.MapPatch("/api/staff/{id:int}/activate", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE pos_staff SET is_active = TRUE WHERE staff_id = @id", new { id });
    if (rows == 0) return Results.NotFound($"No staff member {id}.");
    return Results.Ok(new { Status = "Activated" });
});

// Hard delete. Historical pos_sales.staff_name strings are snapshots - deleting
// a cashier never touches sales, and their already-queued offline sales still
// sync (the sales endpoint only requires a non-blank StaffName).
app.MapDelete("/api/staff/{id:int}", async (int id, HttpContext http) =>
{
    var denied = RequireOwnerAdmin(http); if (denied != null) return denied;
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("DELETE FROM pos_staff WHERE staff_id = @id", new { id });
    if (rows == 0) return Results.NotFound($"No staff member {id}.");
    return Results.Ok(new { Status = "Deleted" });
});

app.MapPost("/api/purchases", async (List<PurchaseLogDto> purchases, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    // A zero/negative Qty used to silently no-op (no lot created, no error) instead of being
    // rejected - reject it up front so a bad line fails the whole ticket instead of vanishing.
    if (purchases.Any(p => p.Qty <= 0)) return Results.BadRequest("Qty must be greater than zero for every purchase line.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch so the MAX()+1 ID assignment below can't race.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

        // Idempotency: if this ticket's transaction_id already committed (the client re-submitted
        // after a lost response), don't create the lots/logs a second time. All lines of one submit
        // share a single client-minted transaction_id.
        if (purchases.Count > 0)
        {
            var txId = purchases[0].TransactionId;
            if (!string.IsNullOrWhiteSpace(txId))
            {
                int existing = await db.ExecuteScalarAsync<int>(
                    "SELECT COUNT(*) FROM purchase_logs WHERE transaction_id = @txId", new { txId }, transaction);
                if (existing > 0) { await transaction.CommitAsync(); return Results.Ok(); }
            }
        }

        // 1. Grab the highest existing IDs to simulate auto-increment
        int nextPurchaseId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(local_id), 0) FROM purchase_logs WHERE branch_name = 'Office'", transaction);
        int nextLotId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = 'Office'", transaction);

        foreach (var p in purchases)
        {
            nextPurchaseId++;
            nextLotId++;

            // 2. Insert with the generated Local IDs
            await db.ExecuteAsync(@"
                INSERT INTO purchase_logs (branch_name, local_id, transaction_id, date, sku, qty, unit_cost, supplier)
                VALUES ('Office', @LocalId, @TransactionId, @Date, @SKU, @Qty, @UnitCost, @Supplier)",
                new { LocalId = nextPurchaseId, p.TransactionId, p.Date, p.SKU, p.Qty, p.UnitCost, p.Supplier }, transaction);

            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost, purchase_transaction_id)
                VALUES ('Office', @LotId, @SKU, @Date, @Qty, @Qty, @UnitCost, @TransactionId)",
                new { LotId = nextLotId, p.SKU, p.Date, p.Qty, p.UnitCost, p.TransactionId }, transaction);
        }
        await transaction.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});
app.MapPost("/api/deliveries", async (List<DeliveryLogDto> deliveries, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    // Same as purchases: a zero/negative Qty used to silently no-op instead of being rejected.
    if (deliveries.Any(d => d.Qty <= 0)) return Results.BadRequest("Qty must be greater than zero for every delivery line.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 ID assignment below,
        // and also stops two concurrent deliveries from both reading the same lot's remaining_qty
        // before either commits (see the FOR UPDATE on the lot query below for the same reason).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

        // Idempotency: a re-submit of the same transaction_id (client didn't hear back after a
        // committed request) returns the already-recorded rows for printing instead of deducting
        // Office stock and inserting the ticket a second time. All lines share one transaction_id.
        if (deliveries.Count > 0)
        {
            var txId = deliveries[0].TransactionId;
            if (!string.IsNullOrWhiteSpace(txId))
            {
                var existing = (await db.QueryAsync<DeliveryLog>(
                    @"SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, to_branch AS ToBranch,
                             total_line_cost AS TotalLineCost, requester AS Requester, reason AS Reason
                      FROM delivery_logs WHERE transaction_id = @txId", new { txId }, transaction)).ToList();
                if (existing.Count > 0) { await transaction.CommitAsync(); return Results.Ok(existing); }
            }
        }

        int nextDeliveryId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(local_id), 0) FROM delivery_logs WHERE branch_name = 'Office'", transaction);
        var insertedRows = new List<DeliveryLog>();

        foreach (var d in deliveries)
        {
            int qtyNeeded = d.Qty;

            // Strongly-typed query: Postgres folds unquoted "AS LotId"/"AS RemainingQty" aliases to
            // lowercase, so the dynamic (non-generic) QueryAsync overload used previously silently
            // returned null for lot.LotId/lot.RemainingQty (case-sensitive dynamic member lookup),
            // which crashed the (int) cast below. QueryAsync<LotRow> maps columns case-insensitively.
            // date_received only carries a date (no time), so purchases entered on the same day
            // tie on the first sort key; lot_id (assigned in purchase order) breaks the tie so FIFO
            // stays deterministic instead of depending on Postgres's arbitrary tie-break order.
            // FOR UPDATE locks these rows so a concurrent request touching the same SKU has to wait
            // instead of reading the same pre-deduction remaining_qty (which would let both requests
            // deduct from the same stock and drive remaining_qty negative).
            // branch_name = 'Office' throughout: deliveries only ever draw from Office stock,
            // and lot_id is only unique per branch (UNIQUE (branch_name, lot_id)), so an
            // unscoped WHERE lot_id would also hit a same-numbered lot in another branch.
            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @SKU AND remaining_qty > 0 AND branch_name = 'Office'
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { d.SKU }, transaction);

            foreach (var lot in lots)
            {
                if (qtyNeeded <= 0) break;

                int qtyToTake = Math.Min(qtyNeeded, lot.RemainingQty);
                qtyNeeded -= qtyToTake;
                decimal chunkCost = qtyToTake * lot.UnitCost;

                await db.ExecuteAsync(@"
                    UPDATE inventory_lots
                    SET remaining_qty = remaining_qty - @Take
                    WHERE lot_id = @LotId AND branch_name = 'Office'",
                    new { Take = qtyToTake, LotId = lot.LotId }, transaction);

                nextDeliveryId++;
                await db.ExecuteAsync(@"
                    INSERT INTO delivery_logs (branch_name, local_id, transaction_id, date, sku, qty, to_branch, total_line_cost, requester, reason)
                    VALUES ('Office', @LocalId, @TransactionId, CAST(@Date AS TIMESTAMP), @SKU, @Qty, @ToBranch, @TotalLineCost, @Requester, @Reason)",
                    new { LocalId = nextDeliveryId, d.TransactionId, d.Date, d.SKU, Qty = qtyToTake, d.ToBranch, TotalLineCost = chunkCost, d.Requester, d.Reason }, transaction);

                insertedRows.Add(new DeliveryLog
                {
                    TransactionId = d.TransactionId,
                    Date = DateTime.Parse(d.Date),
                    SKU = d.SKU,
                    Qty = qtyToTake,
                    ToBranch = d.ToBranch,
                    TotalLineCost = chunkCost,
                    Requester = d.Requester,
                    Reason = d.Reason
                });
            }

            if (qtyNeeded > 0)
                throw new Exception($"Insufficient inventory for SKU: {d.SKU}. Short by {qtyNeeded}.");
        }
        await transaction.CommitAsync();
        return Results.Ok(insertedRows);
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});

// --- HISTORY & VIEW ENDPOINTS ---
app.MapGet("/api/purchases/tickets", async (DateTime start, DateTime end, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, supplier AS Supplier, SUM(qty * unit_cost) AS TotalAmount
                FROM purchase_logs WHERE date >= @start AND date <= @end GROUP BY transaction_id, date, supplier ORDER BY date DESC";
    return Results.Ok(await db.QueryAsync<PurchaseTicketSummary>(sql, new { start, end }));
});

app.MapGet("/api/purchases/{id}", async (string id, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<PurchaseLog>("SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, unit_cost AS UnitCost, supplier AS Supplier FROM purchase_logs WHERE transaction_id = @id", new { id }));
});

app.MapDelete("/api/purchases/{id}", async (string id, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Same lock every other Office-inventory writer (deliveries, office POS sales) takes before
        // touching inventory_lots. Without it, this delete's "already consumed" check below is a
        // plain read that can pass on a stale pre-commit snapshot while a concurrent delivery is
        // mid-FIFO-consumption of these same lots; this delete would then only block later on the
        // lots' row lock, and once unblocked, delete them anyway with no re-check - destroying a
        // lot's record right after it was legitimately consumed. Taking the lock up front instead
        // makes this delete wait for any in-flight consumer to finish before it even reads consumed
        // qty, so the check always sees the true current state.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: tx);

        var lines = await db.QueryAsync("SELECT sku, qty, unit_cost FROM purchase_logs WHERE transaction_id = @id", new { id }, tx);
        foreach (var line in lines)
        {
            // Matches lots back to this specific purchase ticket via purchase_transaction_id rather
            // than sku+qty+unit_cost, which could otherwise match (and delete) lots belonging to a
            // different ticket that happened to share the same sku/qty/cost.
            int consumed = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(SUM(original_qty - remaining_qty), 0) FROM inventory_lots WHERE purchase_transaction_id = @id AND sku = @sku",
                new { id, sku = line.sku }, tx);
            if (consumed > 0) throw new Exception($"Cannot delete ticket: {line.sku} has already been used in deliveries.");

            await db.ExecuteAsync("DELETE FROM inventory_lots WHERE purchase_transaction_id = @id AND sku = @sku", new { id, sku = line.sku }, tx);
        }
        await db.ExecuteAsync("DELETE FROM purchase_logs WHERE transaction_id = @id", new { id }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/deliveries/tickets", async (DateTime start, DateTime end, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    // Compare on ::date, not the raw timestamp: delivery_logs.date carries a time component
    // (Delivery.cs stamps DateTime.Now), so a plain `date <= @end` with a date-only end (midnight)
    // silently drops every same-day delivery. Casting both sides to date makes the range whole-day
    // inclusive regardless of what time the client sends - same idea as /api/deliveries/daily's date().
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, to_branch AS ToBranch, SUM(qty) AS TotalItems,
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost,
                       MIN(status) AS Status
                FROM delivery_logs WHERE date::date >= @start::date AND date::date <= @end::date GROUP BY transaction_id, date, to_branch ORDER BY date DESC";
    return Results.Ok(await db.QueryAsync<DeliveryTicketSummary>(sql, new { start, end }));
});

app.MapGet("/api/deliveries/{id}", async (string id, HttpContext http) => {
    using var db = new NpgsqlConnection(connectionString);
    var rows = (await db.QueryAsync<DeliveryLog>("SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, to_branch AS ToBranch, total_line_cost AS TotalLineCost, requester AS Requester, reason AS Reason FROM delivery_logs WHERE transaction_id = @id", new { id })).ToList();
    // Gate on the ticket's DB-verified destination branch (like /accept - never a client-asserted
    // one, which would leak to_branch off a mismatch): office/owner may read any ticket, a branch
    // device only tickets bound for itself. An empty result (unknown id) has no branch to protect,
    // so it returns [] to anyone - no data, no leak, and no way to probe another branch's ids.
    if (rows.Count > 0 && !CanReadBranchScoped(rows[0].ToBranch, http))
        return Results.Problem("This delivery is restricted to the office, the owner, or the destination branch's own devices.", statusCode: 403);
    return Results.Ok(rows);
});

app.MapDelete("/api/deliveries/{id}", async (string id, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Serialize concurrent writers on this branch so the MAX()+1 lot ID assignment below can't race.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: tx);

        // FOR UPDATE (not a plain read) so this blocks on - and then correctly re-observes - a
        // concurrent POST /api/deliveries/{transactionId}/accept that's mid-flight on this same
        // ticket (accept takes a per-branch advisory lock, not this endpoint's Office one, so that
        // lock alone doesn't serialize the two). A plain SELECT here would pass the accepted-check
        // against a stale pre-commit snapshot, then only block later on the unconditional DELETE
        // below with no re-check - letting a delete and an accept both succeed on the same ticket
        // (branch credited by accept, Office restored by delete: duplicated inventory).
        var lines = (await db.QueryAsync(
            "SELECT sku, qty, total_line_cost, status FROM delivery_logs WHERE transaction_id = @id FOR UPDATE",
            new { id }, tx)).ToList();
        if (lines.Any(l => l.status != "InTransit"))
            throw new Exception("Cannot delete: this ticket has already been accepted by the branch.");

        int nextLotId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = 'Office'", tx);
        foreach (var item in lines)
        {
            if (item.qty > 0)
            {
                nextLotId++;
                decimal unitCost = item.total_line_cost / item.qty;
                await db.ExecuteAsync(@"INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                                        VALUES ('Office', @LotId, @sku, CURRENT_TIMESTAMP, @qty, @qty, @cost)",
                                        new { LotId = nextLotId, sku = item.sku, qty = item.qty, cost = unitCost }, tx);
            }
        }
        await db.ExecuteAsync("DELETE FROM delivery_logs WHERE transaction_id = @id", new { id }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/deliveries/daily", async (DateTime targetDate, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT d.transaction_id AS TransactionId, d.to_branch AS ToBranch, d.requester AS Requester, d.reason AS Reason, d.sku AS SKU, i.base_name AS BaseName, i.brand AS Brand, d.qty AS Qty, d.total_line_cost AS TotalLineCost 
                FROM delivery_logs d LEFT JOIN inventory i ON d.sku = i.sku 
                WHERE date(d.date) = date(@targetDate) ORDER BY d.to_branch, d.transaction_id, i.brand, i.base_name";
    return Results.Ok(await db.QueryAsync<DailyDeliveryPrintItem>(sql, new { targetDate }));
});

// --- BRANCH ACCEPTANCE WORKFLOW ---

app.MapGet("/api/deliveries/pending", async (string branch, HttpContext http) => {
    if (!CanReadBranchScoped(branch, http)) return Results.Problem("Pending deliveries are restricted to the office, the owner, or the branch's own devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, to_branch AS ToBranch, SUM(qty) AS TotalItems,
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost,
                       MIN(status) AS Status
                FROM delivery_logs WHERE to_branch = @branch AND status = 'InTransit'
                GROUP BY transaction_id, date, to_branch ORDER BY date ASC";
    return Results.Ok(await db.QueryAsync<DeliveryTicketSummary>(sql, new { branch }));
});

app.MapPost("/api/deliveries/{transactionId}/accept", async (string transactionId, AcceptDeliveryDto dto, HttpContext http) => {
    if (string.IsNullOrWhiteSpace(dto.AcceptedBy)) return Results.BadRequest("AcceptedBy is required.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Lock the ticket's rows so concurrent accepts (double-click, two devices)
        // serialize instead of both succeeding.
        var rows = (await db.QueryAsync(
            "SELECT to_branch, status, sku, qty, total_line_cost FROM delivery_logs WHERE transaction_id = @transactionId FOR UPDATE",
            new { transactionId }, tx)).ToList();

        if (rows.Count == 0)
        {
            await tx.RollbackAsync();
            return Results.NotFound($"No delivery found for ticket {transactionId}.");
        }
        // Gated on the ticket's real to_branch (not the client-asserted dto.Branch) and checked
        // before the mismatch error below - gating on dto.Branch would let an untrusted caller
        // dodge the check by lying about the branch, then read the real to_branch off the
        // mismatch error message it's trying to be denied.
        if (!IsTrustedBranchCaller((string)rows[0].to_branch, http))
        {
            await tx.RollbackAsync();
            return Results.Problem("This endpoint is restricted to trusted branch devices.", statusCode: 403);
        }
        if (rows[0].to_branch != dto.Branch)
        {
            await tx.RollbackAsync();
            return Results.BadRequest($"Ticket {transactionId} is addressed to {rows[0].to_branch}, not {dto.Branch}.");
        }
        if (rows.Any(r => r.status != "InTransit"))
        {
            await tx.RollbackAsync();
            return Results.Conflict($"Ticket {transactionId} has already been accepted.");
        }

        // Credit the receiving branch's own FIFO ledger with one lot per delivery_logs row
        // consumed. Each row already corresponds to exactly one FIFO chunk taken from Office,
        // so total_line_cost / qty recovers that chunk's original unit cost exactly (same
        // recompute idiom already used above in DELETE /api/deliveries/{id}).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { dto.Branch }, tx);
        int nextLotId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @Branch", new { dto.Branch }, tx);
        foreach (var row in rows)
        {
            if (row.qty <= 0) continue;
            nextLotId++;
            decimal unitCost = row.total_line_cost / row.qty;
            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@Branch, @LotId, @sku, CURRENT_TIMESTAMP, @qty, @qty, @UnitCost)",
                new { dto.Branch, LotId = nextLotId, sku = row.sku, qty = row.qty, UnitCost = unitCost }, tx);
        }

        await db.ExecuteAsync(@"UPDATE delivery_logs
            SET status = 'Accepted', accepted_by = @AcceptedBy, accepted_at = CURRENT_TIMESTAMP
            WHERE transaction_id = @transactionId", new { dto.AcceptedBy, transactionId }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});


app.MapGet("/api/inventory", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    // Scoped to Office explicitly: now that branches can hold their own credited lots
    // (see POST /api/deliveries/{id}/accept), an unscoped SUM here would blend every
    // branch's stock into the central/office figure this endpoint is meant to report.
    var products = await db.QueryAsync(@"
        SELECT
            i.sku AS SKU,
            i.brand AS Brand,
            i.base_name AS BaseName,
            i.price AS Price,
            i.category AS Category,
            i.uom AS Uom,
            i.pack_multiplier AS PackMultiplier,
            COALESCE((SELECT SUM(remaining_qty) FROM inventory_lots l WHERE l.sku = i.sku AND l.branch_name = 'Office'), 0) AS CurrentStock
        FROM inventory i
        WHERE i.is_active = true");
    return Results.Ok(products);
});

app.MapGet("/api/inventory/branch/{branch}", async (string branch) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var products = await db.QueryAsync(@"
        SELECT
            i.sku AS SKU,
            i.brand AS Brand,
            i.base_name AS BaseName,
            i.price AS Price,
            i.category AS Category,
            i.uom AS Uom,
            i.pack_multiplier AS PackMultiplier,
            COALESCE((SELECT SUM(remaining_qty) FROM inventory_lots l WHERE l.sku = i.sku AND l.branch_name = @branch), 0) AS CurrentStock
        FROM inventory i
        WHERE i.is_active = true", new { branch });
    return Results.Ok(products);
});

app.MapPost("/api/inventory", async (InventoryItemDto product, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    // Validate up front like every other write - the UI guards these today, but the endpoint
    // shouldn't rely on that (a blank SKU would hit the PK, a negative price is just bad data).
    if (string.IsNullOrWhiteSpace(product.SKU) || string.IsNullOrWhiteSpace(product.BaseName))
        return Results.BadRequest("SKU and BaseName are required.");
    if (product.Price < 0)
        return Results.BadRequest("Price cannot be negative.");

    using var db = new NpgsqlConnection(connectionString);
    try
    {
        await db.ExecuteAsync(@"
            INSERT INTO inventory (sku, brand, base_name, price, is_active) 
            VALUES (@SKU, @Brand, @BaseName, @Price, @IsActive)", product);
        return Results.Ok();
    }
    catch (PostgresException ex) when (ex.SqlState == "23505") // 23505 is PostgreSQL's Unique Violation code
    {
        return Results.Conflict("Duplicate SKU");
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapPut("/api/inventory/{sku}", async (string sku, UpdateProductDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET brand = @Brand, base_name = @BaseName, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku",
        new { dto.Brand, dto.BaseName, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

app.MapPatch("/api/inventory/{sku}/deactivate", async (string sku, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET is_active = false, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku", new { sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Sets a product's production category and purchase-unit conversion. Office-gated
// (not owner-only) per the user's instruction: only SKC Bakery Supply edits this.
app.MapPut("/api/inventory/{sku}/classification", async (string sku, ClassifyInventoryDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    if (dto.Category != "RawMaterial" && dto.Category != "BakedGood" && dto.Category != "DecoratedGood" && dto.Category != "Miscellaneous")
        return Results.BadRequest("Category must be RawMaterial, BakedGood, DecoratedGood, or Miscellaneous.");

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(@"
        UPDATE inventory
        SET category = @Category, uom = @Uom, pack_multiplier = @PackMultiplier, last_updated = CURRENT_TIMESTAMP
        WHERE sku = @sku",
        new { dto.Category, dto.Uom, dto.PackMultiplier, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Sets a product's selling price - the single company-wide price list the POS sells at.
// Sellable = price > 0 (chiffon, e.g., is a BakedGood but an unsellable intermediary, so it
// stays at 0), and each POS additionally narrows by category: SKC Branch excludes
// RawMaterial, the SKC Bakery Supplies office POS sells RawMaterial + Miscellaneous only,
// both filtered client-side per app (see each app's PosLocalStore), not here.
// Owner-gated (like recipes): prices are managed from the SKC Admin app only, though the
// office app's Add Item still sets an initial price at product creation.
app.MapPut("/api/inventory/{sku}/price", async (string sku, SetPriceDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner's device.", statusCode: 403);

    if (dto.Price < 0) return Results.BadRequest("Price cannot be negative.");

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET price = @Price, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku",
        new { dto.Price, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Reconciles a branch's stock with a physical count. Used when a manual inventory
// count (see the client's "print all inventory" count sheet) finds a discrepancy.
// Branch defaults to 'Office' (central stock) but can target any branch's own lots.
app.MapPost("/api/inventory/{sku}/adjust", async (string sku, AdjustInventoryDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    // A physical count can't be negative. Without this, a negative NewCount makes the
    // shrinkage branch below try to remove more stock than currentTotal actually holds -
    // the FIFO loop just exhausts early, but qty_delta/costUsed still get recorded against
    // the full (un-clamped) requested delta, desyncing inventory_adjustments from what
    // inventory_lots actually changed by.
    if (dto.NewCount < 0) return Results.BadRequest("NewCount cannot be negative.");

    string branch = string.IsNullOrWhiteSpace(dto.Branch) ? "Office" : dto.Branch;

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 lot ID assignment below,
        // and (together with the FOR UPDATE in the shrinkage branch) stops a concurrent delivery or
        // adjustment from reading the same lot's remaining_qty before either commits.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @branch))", new { branch }, transaction);

        // Every read/write is scoped to @branch: lot_id is only unique per branch
        // (UNIQUE (branch_name, lot_id)), so an unscoped currentTotal would sum other
        // branches' stock and an unscoped UPDATE could decrement a same-numbered lot elsewhere.
        int currentTotal = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(SUM(remaining_qty), 0) FROM inventory_lots WHERE sku = @sku AND branch_name = @branch", new { sku, branch }, transaction);
        int delta = dto.NewCount - currentTotal;

        if (delta == 0)
        {
            await transaction.CommitAsync();
            return Results.Ok(new { Message = "No discrepancy." });
        }

        decimal costUsed;

        if (delta > 0)
        {
            // Found more stock than the system expected. Cost the new lot at whatever the
            // caller specified; otherwise fall back to the SKU's most recent cost in this
            // branch (or 0 if none) so the stock isn't recorded as worthless.
            costUsed = dto.UnitCost ?? await db.ExecuteScalarAsync<decimal?>(
                "SELECT unit_cost FROM inventory_lots WHERE sku = @sku AND branch_name = @branch ORDER BY date_received DESC, lot_id DESC LIMIT 1",
                new { sku, branch }, transaction) ?? 0m;

            int nextLotId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @branch", new { branch }, transaction) + 1;

            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@branch, @LotId, @sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                new { branch, LotId = nextLotId, sku, Qty = delta, UnitCost = costUsed }, transaction);
        }
        else
        {
            // Shrinkage/damage/miscount: remove stock the same FIFO way a delivery would
            // (oldest lot first, tie-broken by lot_id - see POST /api/deliveries), so the
            // loss is attributed to the oldest-costed stock rather than an arbitrary lot.
            int qtyToRemove = -delta;
            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @sku AND remaining_qty > 0 AND branch_name = @branch
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { sku, branch }, transaction);

            decimal totalCostRemoved = 0;
            foreach (var lot in lots)
            {
                if (qtyToRemove <= 0) break;

                int qtyFromThisLot = Math.Min(qtyToRemove, lot.RemainingQty);
                qtyToRemove -= qtyFromThisLot;
                totalCostRemoved += qtyFromThisLot * lot.UnitCost;

                await db.ExecuteAsync(
                    "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @branch",
                    new { Take = qtyFromThisLot, LotId = lot.LotId, branch }, transaction);
            }

            // qtyToRemove > 0 here would mean the count claims less stock exists than what we
            // just summed as currentTotal, which is a contradiction - can't actually happen.
            costUsed = totalCostRemoved / -delta;
        }

        await db.ExecuteAsync(@"
            INSERT INTO inventory_adjustments (branch_name, sku, date, qty_delta, unit_cost, reason)
            VALUES (@branch, @sku, CURRENT_TIMESTAMP, @Delta, @CostUsed, @Reason)",
            new { branch, sku, Delta = delta, CostUsed = costUsed, dto.Reason }, transaction);

        await transaction.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/inventory/adjustments", async (DateTime start, DateTime end, string? branch, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT a.date AS Date, a.sku AS SKU, i.brand AS Brand, i.base_name AS BaseName,
               a.qty_delta AS QtyDelta, a.unit_cost AS UnitCost, a.reason AS Reason, a.branch_name AS Branch
        FROM inventory_adjustments a LEFT JOIN inventory i ON a.sku = i.sku
        WHERE a.date::date >= @start::date AND a.date::date <= @end::date
          AND (@branch IS NULL OR a.branch_name = @branch)
        ORDER BY a.date DESC";
    return Results.Ok(await db.QueryAsync<InventoryAdjustmentRow>(sql, new { start, end, branch }));
});

// --- RECIPES (baking + decorating share this: a "recipe" just consumes N input SKUs
// and produces one output SKU; a decorating recipe's inputs happen to include a
// BakedGood). Reads are open - branches need the list to know what they can produce.
// Only mutations are owner-gated (see IsOwnerCaller) - the owner alone maintains recipes.

// includeInactive defaults to false, so every existing caller (SKC Branch's production screen,
// the SKC Admin app) keeps seeing active recipes only. The Admin CLI opts in: it needs the
// deactivated ones to offer reactivation and to refuse creating a duplicate of a retired name.
app.MapGet("/api/recipes", async (bool? includeInactive) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var recipes = (await db.QueryAsync<RecipeRow>(@"
        SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, is_active AS IsActive
        FROM recipes WHERE (@includeInactive OR is_active = true) ORDER BY name",
        new { includeInactive = includeInactive ?? false })).ToList();
    var lines = (await db.QueryAsync<RecipeLineRawRow>(
        "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines")).ToList();
    var outputs = (await db.QueryAsync<RecipeOutputRawRow>(
        "SELECT recipe_id AS RecipeId, output_sku AS OutputSku, weight AS Weight FROM recipe_outputs")).ToList();
    foreach (var r in recipes)
    {
        r.Lines = lines.Where(l => l.RecipeId == r.RecipeId)
            .Select(l => new RecipeLineDto { InputSku = l.InputSku, Qty = l.Qty }).ToList();
        r.Outputs = outputs.Where(o => o.RecipeId == r.RecipeId)
            .Select(o => new RecipeOutputDto { OutputSku = o.OutputSku, Weight = o.Weight }).ToList();
    }
    return Results.Ok(recipes);
});

app.MapGet("/api/recipes/{id}", async (int id) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var recipe = await db.QuerySingleOrDefaultAsync<RecipeRow>(@"
        SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, is_active AS IsActive
        FROM recipes WHERE recipe_id = @id", new { id });
    if (recipe == null) return Results.NotFound();

    var lines = await db.QueryAsync<RecipeLineRawRow>(
        "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines WHERE recipe_id = @id", new { id });
    recipe.Lines = lines.Select(l => new RecipeLineDto { InputSku = l.InputSku, Qty = l.Qty }).ToList();
    var outputs = await db.QueryAsync<RecipeOutputRawRow>(
        "SELECT recipe_id AS RecipeId, output_sku AS OutputSku, weight AS Weight FROM recipe_outputs WHERE recipe_id = @id", new { id });
    recipe.Outputs = outputs.Select(o => new RecipeOutputDto { OutputSku = o.OutputSku, Weight = o.Weight }).ToList();
    return Results.Ok(recipe);
});

app.MapPost("/api/recipes", async (RecipeDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    if (dto.Lines == null || dto.Lines.Count == 0) return Results.BadRequest("A recipe needs at least one input line.");
    var validationError = ValidateRecipeDto(dto);
    if (validationError != null) return Results.BadRequest(validationError);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        int recipeId = await db.ExecuteScalarAsync<int>(@"
            INSERT INTO recipes (name, kind)
            VALUES (@Name, @Kind) RETURNING recipe_id",
            new { dto.Name, dto.Kind }, tx);

        foreach (var line in dto.Lines)
            await db.ExecuteAsync(
                "INSERT INTO recipe_lines (recipe_id, input_sku, qty) VALUES (@recipeId, @InputSku, @Qty)",
                new { recipeId, line.InputSku, line.Qty }, tx);

        foreach (var o in dto.Outputs)
            await db.ExecuteAsync(
                "INSERT INTO recipe_outputs (recipe_id, output_sku, weight) VALUES (@recipeId, @OutputSku, @Weight)",
                new { recipeId, o.OutputSku, o.Weight }, tx);

        await tx.CommitAsync();
        return Results.Ok(new { RecipeId = recipeId });
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapPut("/api/recipes/{id}", async (int id, RecipeDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    if (dto.Lines == null || dto.Lines.Count == 0) return Results.BadRequest("A recipe needs at least one input line.");
    var validationError = ValidateRecipeDto(dto);
    if (validationError != null) return Results.BadRequest(validationError);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        int rows = await db.ExecuteAsync(@"
            UPDATE recipes SET name = @Name, kind = @Kind
            WHERE recipe_id = @id", new { id, dto.Name, dto.Kind }, tx);
        if (rows == 0) { await tx.RollbackAsync(); return Results.NotFound(); }

        await db.ExecuteAsync("DELETE FROM recipe_lines WHERE recipe_id = @id", new { id }, tx);
        foreach (var line in dto.Lines)
            await db.ExecuteAsync(
                "INSERT INTO recipe_lines (recipe_id, input_sku, qty) VALUES (@id, @InputSku, @Qty)",
                new { id, line.InputSku, line.Qty }, tx);

        await db.ExecuteAsync("DELETE FROM recipe_outputs WHERE recipe_id = @id", new { id }, tx);
        foreach (var o in dto.Outputs)
            await db.ExecuteAsync(
                "INSERT INTO recipe_outputs (recipe_id, output_sku, weight) VALUES (@id, @OutputSku, @Weight)",
                new { id, o.OutputSku, o.Weight }, tx);

        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapPatch("/api/recipes/{id}/deactivate", async (int id, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE recipes SET is_active = false WHERE recipe_id = @id", new { id });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Mirror of deactivate. Without it, deactivation is one-way and a retired recipe can only come
// back as a new row - which is how two recipes end up sharing a name (the CLI's import then
// can't tell which one a workbook row means).
app.MapPatch("/api/recipes/{id}/activate", async (int id, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE recipes SET is_active = true WHERE recipe_id = @id", new { id });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// --- PRODUCTION (baking + decorating batches) ---
// IP-gated per branchIps above, like /api/deliveries/{id}/accept - ungated for a branch not
// yet on the allowlist.

app.MapPost("/api/production", async (ProductionDto dto, HttpContext http) =>
{
    if (string.IsNullOrWhiteSpace(dto.Branch)) return Results.BadRequest("Branch is required.");
    if (string.IsNullOrWhiteSpace(dto.StaffName)) return Results.BadRequest("StaffName is required.");
    // Gated for branches with a known Tailscale IP set (see branchIps above); a branch not yet
    // onboarded falls through ungated, same as before.
    if (!IsTrustedBranchCaller(dto.Branch, http)) return Results.Problem("This endpoint is restricted to trusted branch devices.", statusCode: 403);
    // Required so the dedup guard below can make a re-submit idempotent (the client mints one
    // PRD-... id per batch and reuses it across a retry after a lost response).
    if (string.IsNullOrWhiteSpace(dto.TransactionId)) return Results.BadRequest("TransactionId is required.");
    // BatchMultiplier <= 0 used to sail through as a silent no-op batch (0 consumed, 0 credited,
    // still recorded); a negative multiplier was only ever caught incidentally by the
    // chk_remaining_qty_non_negative constraint on inventory_lots, surfacing a raw Postgres
    // error. IP gating above is now this endpoint's first line of defense for onboarded branches;
    // this validation remains the only protection for branches not yet on the allowlist.
    if (dto.BatchMultiplier <= 0) return Results.BadRequest("BatchMultiplier must be greater than zero.");
    // Outputs is what the baker actually made (one line per finished-good type). An empty
    // list / all-zero qtys is allowed: a burnt batch still consumes ingredients (recorded as
    // a loss) but credits nothing - warn-but-allow, same spirit as the old zero-yield path.
    dto.Outputs ??= new();
    if (dto.Outputs.Any(o => string.IsNullOrWhiteSpace(o.OutputSku)))
        return Results.BadRequest("Every output line needs a product.");
    if (dto.Outputs.Any(o => o.Qty < 0))
        return Results.BadRequest("Output quantities cannot be negative.");
    if (dto.Outputs.Select(o => o.OutputSku).Distinct(StringComparer.OrdinalIgnoreCase).Count() != dto.Outputs.Count)
        return Results.BadRequest("The same output product is listed twice.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Same per-branch serialization as every other FIFO writer (accept/adjust/deliver).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { dto.Branch }, tx);

        // Idempotency: if this transaction_id already produced a batch for this branch, a prior
        // submit committed and the client just didn't hear back. Return the existing result rather
        // than FIFO-consuming inputs and crediting output a second time.
        var existingBatch = await db.QuerySingleOrDefaultAsync<ExistingProductionBatchRow>(@"
            SELECT local_id AS LocalId, total_input_cost AS TotalInputCost
            FROM production_batches WHERE branch_name = @Branch AND transaction_id = @TransactionId",
            new { dto.Branch, dto.TransactionId }, tx);
        if (existingBatch != null)
        {
            var priorOutputs = (await db.QueryAsync<ProductionOutputRow>(@"
                SELECT output_sku AS OutputSku, qty AS Qty, unit_cost AS UnitCost, cost AS Cost
                FROM production_outputs WHERE branch_name = @Branch AND production_local_id = @LocalId
                ORDER BY id", new { dto.Branch, existingBatch.LocalId }, tx)).ToList();
            await tx.CommitAsync();
            return Results.Ok(new { Outputs = priorOutputs, existingBatch.TotalInputCost });
        }

        var recipe = await db.QuerySingleOrDefaultAsync<RecipeRow>(@"
            SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, is_active AS IsActive
            FROM recipes WHERE recipe_id = @RecipeId", new { dto.RecipeId }, tx);
        if (recipe == null) { await tx.RollbackAsync(); return Results.NotFound($"No recipe {dto.RecipeId}."); }

        var lines = (await db.QueryAsync<RecipeLineRawRow>(
            "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines WHERE recipe_id = @RecipeId",
            new { dto.RecipeId }, tx)).ToList();
        if (lines.Count == 0) { await tx.RollbackAsync(); return Results.BadRequest("Recipe has no input lines."); }

        // The recipe's output menu + weights (server-authoritative; the client only sends
        // {sku, qty}). Validate the requested outputs against it BEFORE consuming any stock,
        // so an unknown SKU fails fast rather than after FIFO work.
        var recipeOutputs = (await db.QueryAsync<RecipeOutputRawRow>(
            "SELECT recipe_id AS RecipeId, output_sku AS OutputSku, weight AS Weight FROM recipe_outputs WHERE recipe_id = @RecipeId",
            new { dto.RecipeId }, tx)).ToList();
        if (recipeOutputs.Count == 0) { await tx.RollbackAsync(); return Results.BadRequest("Recipe has no possible outputs."); }
        var weightBySku = recipeOutputs.ToDictionary(o => o.OutputSku, o => o.Weight, StringComparer.OrdinalIgnoreCase);
        var canonicalSku = recipeOutputs.ToDictionary(o => o.OutputSku, o => o.OutputSku, StringComparer.OrdinalIgnoreCase);
        foreach (var o in dto.Outputs)
            if (!weightBySku.ContainsKey(o.OutputSku))
            { await tx.RollbackAsync(); return Results.BadRequest($"'{o.OutputSku}' is not one of recipe {dto.RecipeId}'s outputs."); }

        // Only outputs actually made (qty > 0) get credited, mapped to the recipe's canonical
        // SKU casing (the inventory FK) and its weight snapshot.
        var made = dto.Outputs.Where(o => o.Qty > 0)
            .Select(o => new { OutputSku = canonicalSku[o.OutputSku], o.Qty, Weight = weightBySku[o.OutputSku] })
            .ToList();

        decimal totalInputCost = 0;
        var consumedRows = new List<(string Sku, int Qty, decimal Cost)>();

        foreach (var line in lines)
        {
            // Rounds up so a fractional multiplier never under-consumes an ingredient.
            int qtyNeeded = (int)Math.Ceiling(line.Qty * dto.BatchMultiplier);

            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @sku AND remaining_qty > 0 AND branch_name = @Branch
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { sku = line.InputSku, dto.Branch }, tx);

            int remaining = qtyNeeded;
            decimal lineCost = 0;
            foreach (var lot in lots)
            {
                if (remaining <= 0) break;
                int take = Math.Min(remaining, lot.RemainingQty);
                remaining -= take;
                lineCost += take * lot.UnitCost;

                await db.ExecuteAsync(
                    "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @Branch",
                    new { Take = take, lot.LotId, dto.Branch }, tx);
            }

            if (remaining > 0)
                throw new InsufficientStockException($"Insufficient stock for {line.InputSku}. Short by {remaining}.");

            totalInputCost += lineCost;
            consumedRows.Add((line.InputSku, qtyNeeded, lineCost));
        }

        // Split the batch's total ingredient cost across the outputs actually made,
        // proportional to qty x weight. weightedUnits == 0 means nothing was made (burnt
        // batch): ingredients are still consumed above (a recorded loss) but no output lots
        // are credited.
        decimal weightedUnits = made.Sum(m => m.Qty * m.Weight);

        int nextLocalId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(local_id), 0) FROM production_batches WHERE branch_name = @Branch", new { dto.Branch }, tx) + 1;

        await db.ExecuteAsync(@"
            INSERT INTO production_batches (branch_name, local_id, transaction_id, recipe_id, staff_name, batch_multiplier, total_input_cost)
            VALUES (@Branch, @LocalId, @TransactionId, @RecipeId, @StaffName, @BatchMultiplier, @TotalInputCost)",
            new { dto.Branch, LocalId = nextLocalId, dto.TransactionId, dto.RecipeId, dto.StaffName, dto.BatchMultiplier,
                  TotalInputCost = totalInputCost }, tx);

        foreach (var c in consumedRows)
            await db.ExecuteAsync(@"
                INSERT INTO production_consumed (branch_name, production_local_id, transaction_id, input_sku, qty, cost)
                VALUES (@Branch, @LocalId, @TransactionId, @Sku, @Qty, @Cost)",
                new { dto.Branch, LocalId = nextLocalId, dto.TransactionId, c.Sku, c.Qty, c.Cost }, tx);

        var outputRows = new List<ProductionOutputRow>();
        if (weightedUnits > 0)
        {
            decimal costPerWeightedUnit = totalInputCost / weightedUnits;
            // Lot ids are per-branch; each output SKU gets its own credited lot, so take the
            // current MAX once and increment locally under the advisory lock held above.
            int nextLotId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @Branch", new { dto.Branch }, tx);

            foreach (var m in made)
            {
                // Banker's rounding (half-to-even) at 4 dp. Summed output cost can differ from
                // total input cost by a few centavos; that drift is accepted (raw-material
                // losses on liquids/powders dwarf it) - see webapp-multi-output-production-plan.md.
                decimal unitCost = Math.Round(m.Weight * costPerWeightedUnit, 4, MidpointRounding.ToEven);
                decimal cost = Math.Round(unitCost * m.Qty, 4, MidpointRounding.ToEven);
                nextLotId += 1;

                await db.ExecuteAsync(@"
                    INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                    VALUES (@Branch, @LotId, @Sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                    new { dto.Branch, LotId = nextLotId, Sku = m.OutputSku, m.Qty, UnitCost = unitCost }, tx);

                await db.ExecuteAsync(@"
                    INSERT INTO production_outputs (branch_name, production_local_id, transaction_id, output_sku, qty, weight, unit_cost, lot_id, cost)
                    VALUES (@Branch, @LocalId, @TransactionId, @Sku, @Qty, @Weight, @UnitCost, @LotId, @Cost)",
                    new { dto.Branch, LocalId = nextLocalId, dto.TransactionId, Sku = m.OutputSku, m.Qty, m.Weight,
                          UnitCost = unitCost, LotId = nextLotId, Cost = cost }, tx);

                outputRows.Add(new ProductionOutputRow { OutputSku = m.OutputSku, Qty = m.Qty, UnitCost = unitCost, Cost = cost });
            }
        }

        await tx.CommitAsync();
        return Results.Ok(new { Outputs = outputRows, TotalInputCost = totalInputCost });
    }
    catch (InsufficientStockException ex) { await tx.RollbackAsync(); return Results.Conflict(ex.Message); }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/production", async (string branch, DateTime? start, DateTime? end, HttpContext http) =>
{
    if (!CanReadBranchScoped(branch, http)) return Results.Problem("Production history is restricted to the office, the owner, or the branch's own devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT p.local_id AS LocalId, p.transaction_id AS TransactionId, p.date AS Date, p.recipe_id AS RecipeId, r.name AS RecipeName,
               p.staff_name AS StaffName, p.batch_multiplier AS BatchMultiplier, p.total_input_cost AS TotalInputCost
        FROM production_batches p LEFT JOIN recipes r ON p.recipe_id = r.recipe_id
        WHERE p.branch_name = @branch
          AND (@start::timestamp IS NULL OR p.date >= @start::timestamp)
          AND (@end::timestamp IS NULL OR p.date <= @end::timestamp)
        ORDER BY p.date DESC";
    var batches = (await db.QueryAsync<ProductionBatchRow>(sql, new { branch, start, end })).ToList();
    if (batches.Count == 0) return Results.Ok(batches);

    // Attach each batch's output ledger. Matched on (branch, local_id) - the same key
    // production_outputs is written under. Historical batches (pre-migration-010) were
    // backfilled into production_outputs, so they carry their single output here too.
    var localIds = batches.Select(b => b.LocalId).ToArray();
    var outputs = (await db.QueryAsync<ProductionOutputJoinRow>(@"
        SELECT production_local_id AS LocalId, output_sku AS OutputSku, qty AS Qty, unit_cost AS UnitCost, cost AS Cost
        FROM production_outputs
        WHERE branch_name = @branch AND production_local_id = ANY(@localIds)
        ORDER BY id", new { branch, localIds })).ToList();
    foreach (var b in batches)
        b.Outputs = outputs.Where(o => o.LocalId == b.LocalId)
            .Select(o => new ProductionOutputRow { OutputSku = o.OutputSku, Qty = o.Qty, UnitCost = o.UnitCost, Cost = o.Cost })
            .ToList();
    return Results.Ok(batches);
});

// POS sale sync: the branch app queues sales in a local SQLite db while offline and pushes
// them here in batches. Idempotent by (branch_name, client_sale_id) - a GUID the POS mints
// at the counter - so retries and double-pushes are the normal path, not an error. Each sale
// gets its own transaction (one bad sale must not block the rest of the batch draining).
// A sale is NEVER rejected for insufficient stock: FIFO consumes what exists and records
// the uncovered remainder as shortfall_qty (oversell is warn-but-allow at the counter,
// because recording production requires connectivity and sales must not stop).
// IP-gated per-sale via branchIps above, like /accept, /api/production, and /void - ungated
// for a branch not yet on the allowlist (branch PCs not yet on Tailscale).
app.MapPost("/api/sales", async (List<PosSaleDto> sales, HttpContext http) =>
{
    var results = new List<PosSaleSyncResult>();

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    foreach (var sale in sales)
    {
        // Cheap validation first, before touching the db at all.
        string? invalid = null;
        if (string.IsNullOrWhiteSpace(sale.ClientSaleId)) invalid = "ClientSaleId is required.";
        else if (string.IsNullOrWhiteSpace(sale.Branch)) invalid = "Branch is required.";
        // Gated per-sale (not per-batch) since each sale carries its own Branch; a branch not
        // yet on the allowlist (see branchIps above) falls through ungated, same as before.
        else if (!IsTrustedBranchCaller(sale.Branch, http)) invalid = "This device is not authorized to submit sales for this branch.";
        else if (string.IsNullOrWhiteSpace(sale.StaffName)) invalid = "StaffName is required.";
        else if (sale.Lines == null || sale.Lines.Count == 0) invalid = "A sale needs at least one line.";
        else if (sale.TotalAmount < 0) invalid = "Sale total cannot be negative.";
        else if (sale.Lines.Any(l => l.SKU != null && l.Qty <= 0)) invalid = "Product line Qty must be greater than zero.";
        else if (sale.Lines.Any(l => l.SKU == null && l.LineTotal > 0)) invalid = "Discount lines (no SKU) cannot be positive.";
        // Defense-in-depth against client-side money drift (e.g. a mis-stored local total):
        // the server is the one place that can catch a mismatch before it's committed.
        else if (Math.Abs(sale.Lines.Sum(l => l.LineTotal) - sale.TotalAmount) > 0.01m)
            invalid = "Sale total does not match the sum of its lines.";

        if (invalid != null)
        {
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "Rejected", Detail = invalid });
            continue;
        }

        using var tx = await db.BeginTransactionAsync();
        try
        {
            // Same per-branch serialization as every other FIFO writer (accept/adjust/deliver/produce).
            await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { sale.Branch }, tx);

            int already = await db.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM pos_sales WHERE branch_name = @Branch AND client_sale_id = @ClientSaleId",
                new { sale.Branch, sale.ClientSaleId }, tx);
            if (already > 0)
            {
                await tx.RollbackAsync();
                results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "AlreadySynced", Detail = "" });
                continue;
            }

            // Every product line must reference a real, active SKU - the POS catalog cache
            // should make this impossible, so a miss means a stale/hand-built payload. While
            // here, capture each SKU's CURRENT selling price so the line can record it below:
            // a sale rung at a stale cached price (the POS caches the catalog, and the owner
            // may change a price afterward) is then detectable instead of committing silently
            // (bug-track.md #98). Row presence - not the price value - is the existence check,
            // since inventory.price is nullable; a NULL-priced row exists but records no price.
            var catalogPrices = new Dictionary<string, decimal>();
            foreach (var line in sale.Lines.Where(l => l.SKU != null))
            {
                var priceRows = (await db.QueryAsync<decimal?>(
                    "SELECT price FROM inventory WHERE sku = @SKU AND is_active = true", new { line.SKU }, tx)).ToList();
                if (priceRows.Count == 0) throw new Exception($"Unknown or inactive SKU '{line.SKU}'.");
                if (priceRows[0].HasValue) catalogPrices[line.SKU!] = priceRows[0]!.Value;
            }

            int nextLocalId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(local_id), 0) FROM pos_sales WHERE branch_name = @Branch", new { sale.Branch }, tx) + 1;

            await db.ExecuteAsync(@"
                INSERT INTO pos_sales (branch_name, local_id, client_sale_id, staff_name, sold_at, total_amount, payment_method)
                VALUES (@Branch, @LocalId, @ClientSaleId, @StaffName, @SoldAt, @TotalAmount, @PaymentMethod)",
                new { sale.Branch, LocalId = nextLocalId, sale.ClientSaleId, sale.StaffName, sale.SoldAt, sale.TotalAmount,
                      // Old WinForms POS clients never send PaymentMethod -> default to Cash.
                      PaymentMethod = string.IsNullOrWhiteSpace(sale.PaymentMethod) ? "Cash" : sale.PaymentMethod!.Trim() }, tx);

            int totalShortfall = 0;
            bool priceVariance = false;
            foreach (var line in sale.Lines)
            {
                int shortfall = 0;
                decimal consumedCost = 0;

                if (line.SKU != null)
                {
                    // FIFO-consume from the branch's own lots; unlike production, a shortage
                    // doesn't throw - the uncovered remainder is recorded on the line.
                    var lots = await db.QueryAsync<LotRow>(@"
                        SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                        FROM inventory_lots
                        WHERE sku = @SKU AND remaining_qty > 0 AND branch_name = @Branch
                        ORDER BY date_received ASC, lot_id ASC
                        FOR UPDATE", new { line.SKU, sale.Branch }, tx);

                    int remaining = line.Qty;
                    foreach (var lot in lots)
                    {
                        if (remaining <= 0) break;
                        int take = Math.Min(remaining, lot.RemainingQty);
                        remaining -= take;
                        consumedCost += take * lot.UnitCost;

                        await db.ExecuteAsync(
                            "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @Branch",
                            new { Take = take, lot.LotId, sale.Branch }, tx);
                    }

                    shortfall = remaining;
                    totalShortfall += shortfall;
                }

                // Server's current price for this SKU (null on discount lines, and on any SKU
                // whose inventory.price is NULL). Recorded per line so stale-price sales are
                // visible for reconciliation; a mismatch is warned-not-rejected below - an
                // offline sale legitimately predates a price change, and rejecting would drop
                // real revenue (bug-track.md #98).
                decimal? catalogPrice = line.SKU != null && catalogPrices.TryGetValue(line.SKU, out var cp) ? cp : (decimal?)null;
                if (catalogPrice != null && Math.Abs(line.UnitPrice - catalogPrice.Value) > 0.01m) priceVariance = true;

                await db.ExecuteAsync(@"
                    INSERT INTO pos_sale_lines (branch_name, client_sale_id, sku, description, qty, unit_price, line_total, shortfall_qty, consumed_cost, catalog_price)
                    VALUES (@Branch, @ClientSaleId, @SKU, @Description, @Qty, @UnitPrice, @LineTotal, @Shortfall, @ConsumedCost, @CatalogPrice)",
                    new { sale.Branch, sale.ClientSaleId, line.SKU, line.Description, line.Qty, line.UnitPrice, line.LineTotal,
                          Shortfall = shortfall, ConsumedCost = consumedCost, CatalogPrice = catalogPrice }, tx);
            }

            await tx.CommitAsync();
            var notes = new List<string>();
            if (totalShortfall > 0) notes.Add($"Stock short by {totalShortfall} across the sale - record baking/decorating.");
            // Warn-not-reject: the sale is committed at the price the customer was charged;
            // this note just surfaces that a line differs from the current catalogue price
            // (a price change after the POS cached its catalog). The per-line catalog_price
            // column above is the durable record for reconciliation. Status stays
            // Synced/SyncedWithShortfall - no new wire status, so old clients are unaffected.
            if (priceVariance) notes.Add("One or more lines sold at a price that differs from the current catalogue price.");
            results.Add(new PosSaleSyncResult
            {
                ClientSaleId = sale.ClientSaleId,
                Status = totalShortfall > 0 ? "SyncedWithShortfall" : "Synced",
                Detail = string.Join(" ", notes)
            });
        }
        catch (PostgresException ex) when (ex.SqlState == "23505")
        {
            // Two clients raced the same client_sale_id past the COUNT check; the UNIQUE
            // constraint is the backstop and the sale is safely on the server already.
            await tx.RollbackAsync();
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "AlreadySynced", Detail = "" });
        }
        catch (Exception ex)
        {
            await tx.RollbackAsync();
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "Rejected", Detail = ex.Message });
        }
    }

    return Results.Ok(results);
});

// Sales history for the office's Branch Sales Report. start/end are required (not
// DateTime?) to sidestep the Npgsql nullable-DateTime type-inference bug documented
// on /api/production above.
app.MapGet("/api/sales", async (string branch, DateTime start, DateTime end, HttpContext http) =>
{
    if (!CanReadBranchScoped(branch, http)) return Results.Problem("Sales history is restricted to the office, the owner, or the branch's own devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT s.local_id AS LocalId, s.client_sale_id AS ClientSaleId, s.staff_name AS StaffName,
               s.sold_at AS SoldAt, s.total_amount AS TotalAmount, s.voided AS Voided, s.payment_method AS PaymentMethod,
               COALESCE((SELECT SUM(l.shortfall_qty) FROM pos_sale_lines l
                         WHERE l.branch_name = s.branch_name AND l.client_sale_id = s.client_sale_id), 0) > 0 AS HasShortfall
        FROM pos_sales s
        WHERE s.branch_name = @branch AND s.sold_at >= @start AND s.sold_at <= @end
        ORDER BY s.sold_at DESC";
    return Results.Ok(await db.QueryAsync<PosSaleSummaryRow>(sql, new { branch, start, end }));
});

app.MapGet("/api/sales/{branch}/{clientSaleId}", async (string branch, string clientSaleId, HttpContext http) =>
{
    if (!CanReadBranchScoped(branch, http)) return Results.Problem("Sales history is restricted to the office, the owner, or the branch's own devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var lines = (await db.QueryAsync<PosSaleLineRow>(@"
        SELECT sku AS SKU, description AS Description, qty AS Qty, unit_price AS UnitPrice,
               line_total AS LineTotal, shortfall_qty AS ShortfallQty
        FROM pos_sale_lines
        WHERE branch_name = @branch AND client_sale_id = @clientSaleId
        ORDER BY id ASC", new { branch, clientSaleId })).ToList();
    return lines.Count == 0 ? Results.NotFound() : Results.Ok(lines);
});

// Flat line-level sales over a date range - one row per item per sale, carrying its parent sale's
// no./time/cashier/voided flag. Exists so the branch end-of-day report can export a CSV that Excel
// can SUMIFS into a per-item breakdown: /api/sales returns sale-level rows only (no SKU or qty), so
// without this the client would have to call the per-sale detail endpoint once per sale. No route
// conflict with /api/sales/{branch}/{clientSaleId} - that one has three segments, this has two.
// Voided sales are returned rather than filtered so the export can show them as reversed rather
// than silently dropping rows the printed report accounts for.
app.MapGet("/api/sales/lines", async (string branch, DateTime start, DateTime end, HttpContext http) =>
{
    if (!CanReadBranchScoped(branch, http)) return Results.Problem("Sales history is restricted to the office, the owner, or the branch's own devices.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT s.local_id AS SaleNo, s.client_sale_id AS ClientSaleId, s.sold_at AS SoldAt,
               s.staff_name AS StaffName, s.voided AS Voided, s.payment_method AS PaymentMethod,
               l.sku AS SKU, l.description AS Description, l.qty AS Qty,
               l.unit_price AS UnitPrice, l.line_total AS LineTotal, l.shortfall_qty AS ShortfallQty,
               l.catalog_price AS CatalogPrice
        FROM pos_sales s
        JOIN pos_sale_lines l
          ON l.branch_name = s.branch_name AND l.client_sale_id = s.client_sale_id
        WHERE s.branch_name = @branch AND s.sold_at >= @start AND s.sold_at <= @end
        ORDER BY s.sold_at ASC, l.id ASC";
    return Results.Ok(await db.QueryAsync<PosSaleLineExportRow>(sql, new { branch, start, end }));
});

// Void a completed sale. Reverses its inventory effect by restocking exactly what FIFO actually
// consumed (qty - shortfall_qty, valued at the recorded consumed_cost) and flags the sale as voided.
// Idempotent: re-voiding is a harmless no-op, so a retry after a lost response is safe. Online-only
// - the sale must have synced first (same connectivity posture as accept/production). Discount lines
// (sku NULL) and fully-shortfall lines restock nothing. IP-gated per branchIps above, like the
// other branch writes - ungated for a branch not yet on the allowlist.
app.MapPost("/api/sales/{branch}/{clientSaleId}/void", async (string branch, string clientSaleId, VoidSaleDto dto, HttpContext http) =>
{
    if (string.IsNullOrWhiteSpace(dto.VoidedBy)) return Results.BadRequest("VoidedBy is required.");
    if (!IsTrustedBranchCaller(branch, http)) return Results.Problem("This endpoint is restricted to trusted branch devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Serialize with every other FIFO writer on this branch before touching lot ids.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @branch))", new { branch }, tx);

        // Lock the sale header so two concurrent voids serialize instead of both restocking.
        var sale = await db.QuerySingleOrDefaultAsync(
            "SELECT voided FROM pos_sales WHERE branch_name = @branch AND client_sale_id = @clientSaleId FOR UPDATE",
            new { branch, clientSaleId }, tx);
        if (sale == null) { await tx.RollbackAsync(); return Results.NotFound($"No sale {clientSaleId} for {branch}."); }
        if ((bool)sale.voided)
        {
            await tx.CommitAsync();
            return Results.Ok(new { Status = "AlreadyVoided" });
        }

        // Raw column names (no aliases) so the dynamic overload's case-sensitive member lookup
        // matches Postgres's lowercase columns - same idiom as DELETE /api/deliveries.
        var saleLines = await db.QueryAsync(
            "SELECT sku, qty, shortfall_qty, consumed_cost FROM pos_sale_lines WHERE branch_name = @branch AND client_sale_id = @clientSaleId",
            new { branch, clientSaleId }, tx);

        int nextLotId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @branch", new { branch }, tx);

        foreach (var line in saleLines)
        {
            if (line.sku == null) continue;                          // discount line - no inventory effect
            int consumedQty = (int)line.qty - (int)line.shortfall_qty; // what FIFO actually deducted
            if (consumedQty <= 0) continue;                          // fully shortfall - nothing to return
            decimal unitCost = (decimal)line.consumed_cost / consumedQty;
            nextLotId++;
            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@branch, @LotId, @sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                new { branch, LotId = nextLotId, sku = (string)line.sku, Qty = consumedQty, UnitCost = unitCost }, tx);
        }

        await db.ExecuteAsync(@"
            UPDATE pos_sales SET voided = TRUE, voided_at = CURRENT_TIMESTAMP, voided_by = @VoidedBy
            WHERE branch_name = @branch AND client_sale_id = @clientSaleId",
            new { dto.VoidedBy, branch, clientSaleId }, tx);

        await tx.CommitAsync();
        return Results.Ok(new { Status = "Voided" });
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

// SPA fallback: any non-API path that matched no endpoint serves the React shell
// so deep links and refreshes work. /api/* is excluded on purpose - the whole
// curl-based verification methodology depends on an unknown endpoint returning a
// real 404 rather than 200 + a page of HTML.
if (Directory.Exists(Path.Combine(app.Environment.ContentRootPath, "wwwroot")))
{
    app.MapFallback(async http =>
    {
        if (http.Request.Path.StartsWithSegments("/api"))
        {
            http.Response.StatusCode = 404;
            return;
        }
        // index.html names hashed asset files, so it must never be cached or a
        // browser will keep asking for chunks the last deploy deleted.
        http.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
        http.Response.ContentType = "text/html";
        await http.Response.SendFileAsync(Path.Combine(app.Environment.ContentRootPath, "wwwroot", "index.html"));
    });
}

app.Run();

// DTO Schemas matching the SQLite structures

// --- webapp auth -----------------------------------------------------------

// Stashed in HttpContext.Items by the session middleware and read by the gates.
public class SessionUser
{
    public int UserId { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;   // Owner | Office | Branch
    public string? BranchName { get; set; }
    public bool MustChangePassword { get; set; }
}

public class AppUserRow
{
    public int UserId { get; set; }
    public string Username { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string? BranchName { get; set; }
    public bool IsActive { get; set; }
    public bool MustChangePassword { get; set; }
}

// Same shape minus the hash - never serialize AppUserRow to a client.
public class AppUserListRow
{
    public int UserId { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string? BranchName { get; set; }
    public bool IsActive { get; set; }
    public bool MustChangePassword { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class BootstrapDto
{
    public string? Password { get; set; }
}

public class LoginDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
}

public class ChangePasswordDto
{
    public string? CurrentPassword { get; set; }
    public string? NewPassword { get; set; }
}

public class CreateUserDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string Role { get; set; } = string.Empty;
    public string? BranchName { get; set; }
}

public class UpdateUserDto
{
    public string Role { get; set; } = string.Empty;
    public string? BranchName { get; set; }
}

public class ResetPasswordDto
{
    public string? NewPassword { get; set; }
}

// --- device -> tier registry (migration 011) -------------------------------

public class AppDeviceRow
{
    public int DeviceId { get; set; }
    public string TailscaleIp { get; set; } = string.Empty;
    public string Tier { get; set; } = string.Empty;   // Owner | Office | Branch
    public string? BranchName { get; set; }
    public string? Label { get; set; }
    public bool IsActive { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CreateDeviceDto
{
    public string? TailscaleIp { get; set; }
    public string Tier { get; set; } = string.Empty;
    public string? BranchName { get; set; }
    public string? Label { get; set; }
}

public class UpdateDeviceDto
{
    public string? TailscaleIp { get; set; }
    public string Tier { get; set; } = string.Empty;
    public string? BranchName { get; set; }
    public string? Label { get; set; }
}

// Owner admin list - no PIN material.
public class PosStaffRow
{
    public int StaffId { get; set; }
    public string BranchName { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public bool IsActive { get; set; }
    public DateTime CreatedAt { get; set; }
}

// The tills' branch feed - includes the salt+hash for offline PIN verification.
public class PosStaffPublicRow
{
    public int StaffId { get; set; }
    public string StaffName { get; set; } = string.Empty;
    public string PinSalt { get; set; } = string.Empty;
    public string PinHash { get; set; } = string.Empty;
}

public class CreateStaffDto
{
    public string? BranchName { get; set; }
    public string? StaffName { get; set; }
    public string? Pin { get; set; }
}

public class UpdateStaffDto
{
    public string? BranchName { get; set; }
    public string? StaffName { get; set; }
}

public class SetStaffPinDto
{
    public string? Pin { get; set; }
}

// The active-device allowlists, pre-expanded for the three IP gates. Owner-tier
// IPs are unioned into OfficeIps and into every branch's set, so a single
// highest-tier row per device reproduces the old overlapping literals.
public sealed class DeviceSnapshot
{
    public HashSet<string> OwnerIps { get; init; } = new();
    public HashSet<string> OfficeIps { get; init; } = new();
    public Dictionary<string, HashSet<string>> BranchIps { get; init; } =
        new(StringComparer.OrdinalIgnoreCase);
}

// In-process cache of app_devices. The IP gates run on EVERY request, so they
// must not hit Postgres each time. Reloaded lazily when older than the TTL (a
// safety net for out-of-band psql edits) and invalidated immediately by the
// /api/devices writes. The API is single-instance (same note as loginAttempts),
// so an in-process cache with write-invalidation is fully coherent. A DB error
// during Load() degrades to an empty snapshot rather than throwing out of a
// gate: the emergency owner IPs still admit the owner to repair the registry.
public sealed class DeviceRegistry
{
    private const int TtlSeconds = 30;
    private readonly string _connectionString;
    private readonly object _lock = new();
    private volatile DeviceSnapshot? _snapshot;
    private DateTime _loadedUtc = DateTime.MinValue;

    public DeviceRegistry(string connectionString) => _connectionString = connectionString;

    public DeviceSnapshot Current()
    {
        var snap = _snapshot;
        if (snap != null && (DateTime.UtcNow - _loadedUtc).TotalSeconds < TtlSeconds) return snap;
        lock (_lock)
        {
            if (_snapshot != null && (DateTime.UtcNow - _loadedUtc).TotalSeconds < TtlSeconds)
                return _snapshot;
            var loaded = Load();
            _snapshot = loaded;
            _loadedUtc = DateTime.UtcNow;
            return loaded;
        }
    }

    public void Invalidate()
    {
        lock (_lock) { _snapshot = null; _loadedUtc = DateTime.MinValue; }
    }

    private DeviceSnapshot Load()
    {
        try
        {
            using var db = new Npgsql.NpgsqlConnection(_connectionString);
            var rows = db.Query<DeviceRow>(
                "SELECT tailscale_ip AS TailscaleIp, tier AS Tier, branch_name AS BranchName " +
                "FROM app_devices WHERE is_active = true").ToList();

            var owner = rows.Where(r => r.Tier == "Owner").Select(r => r.TailscaleIp).ToHashSet();
            var office = rows.Where(r => r.Tier is "Owner" or "Office").Select(r => r.TailscaleIp).ToHashSet();
            var branch = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var r in rows.Where(r => r.Tier == "Branch" && r.BranchName != null))
            {
                if (!branch.TryGetValue(r.BranchName!, out var set))
                {
                    set = new HashSet<string>(owner);   // owner-tier devices satisfy every branch
                    branch[r.BranchName!] = set;
                }
                set.Add(r.TailscaleIp);
            }
            return new DeviceSnapshot { OwnerIps = owner, OfficeIps = office, BranchIps = branch };
        }
        catch
        {
            // DB unreachable: empty snapshot. Owner still gets in via emergencyOwnerIps.
            return new DeviceSnapshot();
        }
    }

    private sealed class DeviceRow
    {
        public string TailscaleIp { get; set; } = string.Empty;
        public string Tier { get; set; } = string.Empty;
        public string? BranchName { get; set; }
    }
}

public class ClassifyInventoryDto
{
    public string Category { get; set; } = "RawMaterial";
    public string? Uom { get; set; }
    public decimal PackMultiplier { get; set; } = 1.0m;
}

public class RecipeLineDto
{
    public string InputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
}

public class RecipeLineRawRow
{
    public int RecipeId { get; set; }
    public string InputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
}

// A recipe's possible outputs. Weight is a relative size factor (e.g. 8-inch=40,
// cupcake=2) used to split a batch's ingredient cost across the outputs actually
// made: each output's cost share is proportional to qty x weight. With a single
// output the weight is irrelevant (that output gets the whole cost).
public class RecipeOutputDto
{
    public string OutputSku { get; set; } = string.Empty;
    public decimal Weight { get; set; } = 1;
}

public class RecipeOutputRawRow
{
    public int RecipeId { get; set; }
    public string OutputSku { get; set; } = string.Empty;
    public decimal Weight { get; set; }
}

public class RecipeDto
{
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty; // "Baking" or "Decorating"
    public List<RecipeOutputDto> Outputs { get; set; } = new();
    public List<RecipeLineDto> Lines { get; set; } = new();
}

public class RecipeRow
{
    public int RecipeId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public bool IsActive { get; set; }
    public List<RecipeOutputDto> Outputs { get; set; } = new();
    public List<RecipeLineDto> Lines { get; set; } = new();
}

// Thrown for a FIFO shortfall so the catch block can return a clean 409 instead of a raw 500
// (see bug-track.md's "POST /api/production returns a raw 500..." entry).
public class InsufficientStockException : Exception
{
    public InsufficientStockException(string message) : base(message) { }
}

// One line of "what the baker actually made" for a batch. Qty is per finished-good
// type; the server looks up the weight from the recipe (weights are never client-
// supplied). Qty 0 outputs can be sent and are ignored.
public class ProductionOutputInputDto
{
    public string OutputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
}

public class ProductionDto
{
    public string Branch { get; set; } = string.Empty;
    public int RecipeId { get; set; }
    public string StaffName { get; set; } = string.Empty;
    public decimal BatchMultiplier { get; set; } = 1;
    public List<ProductionOutputInputDto> Outputs { get; set; } = new();
    public string TransactionId { get; set; } = string.Empty;
}

// Minimal row for the idempotency early-return: enough to look the batch's
// already-recorded outputs back up by (branch, local_id).
public class ExistingProductionBatchRow
{
    public int LocalId { get; set; }
    public decimal TotalInputCost { get; set; }
}

public class ProductionOutputRow
{
    public string OutputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public decimal Cost { get; set; }
}

// Raw row for the GET /api/production output fan-out: carries the batch's local_id
// so outputs can be matched back to their parent batch in code.
public class ProductionOutputJoinRow
{
    public int LocalId { get; set; }
    public string OutputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public decimal Cost { get; set; }
}

public class ProductionBatchRow
{
    public int LocalId { get; set; }
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public int RecipeId { get; set; }
    public string RecipeName { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public decimal BatchMultiplier { get; set; }
    public decimal TotalInputCost { get; set; }
    public List<ProductionOutputRow> Outputs { get; set; } = new();
}

public class InventoryItemDto
{
    public string SKU { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public bool IsActive { get; set; }
}

public class SetPriceDto
{
    public decimal Price { get; set; }
}

public class PosSaleLineDto
{
    public string? SKU { get; set; } // null = discount line (no inventory effect)
    public string Description { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
}

public class PosSaleDto
{
    public string ClientSaleId { get; set; } = string.Empty; // GUID minted offline by the POS
    public string Branch { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public DateTime SoldAt { get; set; } // counter time, not sync time
    public decimal TotalAmount { get; set; }
    public string? PaymentMethod { get; set; } // Cash (default if null - old WinForms clients never send it), GCash, GCash Terminal, Foodpanda
    public List<PosSaleLineDto> Lines { get; set; } = new();
}

public class PosSaleSyncResult
{
    public string ClientSaleId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // Synced | AlreadySynced | SyncedWithShortfall | Rejected
    public string Detail { get; set; } = string.Empty;
}

public class PosSaleSummaryRow
{
    public int LocalId { get; set; }
    public string ClientSaleId { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public DateTime SoldAt { get; set; }
    public decimal TotalAmount { get; set; }
    public string PaymentMethod { get; set; } = "Cash";
    public bool HasShortfall { get; set; }
    public bool Voided { get; set; }
}

// One sale line flattened with its parent sale's identity, for the branch end-of-day CSV export.
public class PosSaleLineExportRow
{
    public int SaleNo { get; set; }
    public string ClientSaleId { get; set; } = string.Empty;
    public DateTime SoldAt { get; set; }
    public string StaffName { get; set; } = string.Empty;
    public bool Voided { get; set; }
    public string PaymentMethod { get; set; } = "Cash";
    public string? SKU { get; set; }
    public string Description { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
    public int ShortfallQty { get; set; }
    public decimal? CatalogPrice { get; set; } // server price at sync time; null for discount lines / pre-009 rows
}

public class VoidSaleDto
{
    public string VoidedBy { get; set; } = string.Empty;
}

public class PosSaleLineRow
{
    public string? SKU { get; set; }
    public string Description { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
    public int ShortfallQty { get; set; }
}

public class PurchaseLogDto
{
    public int Id { get; set; }
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public string Supplier { get; set; } = string.Empty;
}

public class LotRow
{
    public int LotId { get; set; }
    public int RemainingQty { get; set; }
    public decimal UnitCost { get; set; }
}

public class UpdateProductDto
{
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
}

public class AdjustInventoryDto
{
    public int NewCount { get; set; }
    public decimal? UnitCost { get; set; }
    public string Reason { get; set; } = string.Empty;
    public string Branch { get; set; } = "Office";
}

public class InventoryAdjustmentRow
{
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public int QtyDelta { get; set; }
    public decimal UnitCost { get; set; }
    public string Reason { get; set; } = string.Empty;
    public string Branch { get; set; } = string.Empty;
}

public class DeliveryLogDto
{
    public int Id { get; set; }
    public string TransactionId { get; set; } = string.Empty;
    public string Date { get; set; } = string.Empty;
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public decimal TotalLineCost { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
}

public class InventoryLotDto
{
    public int LotId { get; set; }
    public string SKU { get; set; } = string.Empty;
    public string DateReceived { get; set; } = string.Empty;
    public int OriginalQty { get; set; }
    public int RemainingQty { get; set; }
    public decimal UnitCost { get; set; }
}

public class SyncResponse
{
    public bool Success { get; set; }
    public List<string> SyncedInventorySKUs { get; set; } = new();
    public List<int> SyncedPurchaseIds { get; set; } = new();
    public List<int> SyncedDeliveryIds { get; set; } = new();
    public List<int> SyncedLotIds { get; set; } = new();
}

public class PurchaseTicketSummary
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string Supplier { get; set; } = string.Empty;
    public decimal TotalAmount { get; set; }
}

public class PurchaseLog
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public string Supplier { get; set; } = string.Empty;
}

public class DeliveryTicketSummary
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public int TotalItems { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public decimal TotalCost { get; set; }
    public string Status { get; set; } = string.Empty;
}

public class AcceptDeliveryDto
{
    public string Branch { get; set; } = string.Empty;
    public string AcceptedBy { get; set; } = string.Empty;
}

public class DeliveryLog
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public decimal TotalLineCost { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
}

public class DailyDeliveryPrintItem
{
    public string TransactionId { get; set; } = string.Empty;
    public string ToBranch { get; set; } = string.Empty;
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public string SKU { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal TotalLineCost { get; set; }
}
