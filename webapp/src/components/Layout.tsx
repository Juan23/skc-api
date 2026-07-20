import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { Role } from '../api/types'

interface NavItem {
  to: string
  label: string
  roles: Role[]
}

// Phase 1 ships the shells only; Phase 2 fills them in and adds the report
// entries. Owner sees everything, so `roles` lists the non-owner roles that
// also get the item.
const NAV: NavItem[] = [
  { to: '/office', label: 'Office', roles: ['Office'] },
  { to: '/branch', label: 'Branch', roles: ['Branch'] },
  { to: '/owner', label: 'Owner', roles: [] },
]

export function Layout() {
  const { user, logout } = useAuth()
  const visible = NAV.filter((i) => user?.role === 'Owner' || (user && i.roles.includes(user.role)))

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
