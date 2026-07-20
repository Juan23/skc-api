import { NavLink } from 'react-router-dom'

// Sub-navigation inside a section (Office / Branch / Owner). The top bar picks
// the section; this picks the screen. `end` on the index link stops it staying
// highlighted on every child route.
export function SectionNav({ items }: { items: { to: string; label: string }[] }) {
  return (
    <nav className="subnav">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
