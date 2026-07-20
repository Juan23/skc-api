import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { Role } from '../api/types'

interface NavItem {
  to: string
  label: string
  roles: Role[]
}

// Top-level sections; each one's screens live in its own SectionNav.
//
// The Owner is a superuser and can reach any route, but the Branch section is
// deliberately NOT offered to them: every screen in it is scoped to the
// session's own branch_name, which an Owner account doesn't have. The owner
// reads branch data through the office's "Stock by location" and "Branch sales"
// reports instead, which take a branch picker.
const NAV: NavItem[] = [
  { to: '/office', label: 'Office', roles: ['Owner', 'Office'] },
  { to: '/branch', label: 'Branch', roles: ['Branch'] },
  { to: '/owner', label: 'Owner', roles: ['Owner'] },
]

export function Layout() {
  const { user, logout } = useAuth()
  const visible = NAV.filter((i) => user && i.roles.includes(user.role))

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">SKC</span>
        <nav>
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="who">
            {user?.username}
            <span className="muted">
              {' '}
              · {user?.role}
              {user?.branchName ? ` · ${user.branchName}` : ''}
            </span>
          </span>
          <NavLink to="/change-password" className="navlink">
            Password
          </NavLink>
          <button className="btn neutral" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
