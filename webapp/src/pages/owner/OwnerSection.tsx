import { Navigate, Route, Routes } from 'react-router-dom'
import { SectionNav } from '../../components/SectionNav'
import { Users } from './Users'
import { Recipes } from './Recipes'
import { Classify } from './Classify'

// Everything here needs an Owner session AND an owner device. The nav is only
// shown to Owner accounts, but that's cosmetic - the server gates are what
// actually enforce it, and they'll 403 these screens from the office PC.
const ITEMS = [
  { to: '/owner', label: 'Users' },
  { to: '/owner/recipes', label: 'Recipes' },
  { to: '/owner/products', label: 'Products & pricing' },
]

export function OwnerSection() {
  return (
    <>
      <SectionNav items={ITEMS} />
      <Routes>
        <Route index element={<Users />} />
        <Route path="recipes" element={<Recipes />} />
        <Route path="products" element={<Classify />} />
        <Route path="*" element={<Navigate to="/owner" replace />} />
      </Routes>
    </>
  )
}
