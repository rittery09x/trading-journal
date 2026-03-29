/**
 * Login layout: full-screen overlay that sits on top of the root layout,
 * effectively hiding the sidebar on the /login route.
 */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      {children}
    </div>
  )
}
