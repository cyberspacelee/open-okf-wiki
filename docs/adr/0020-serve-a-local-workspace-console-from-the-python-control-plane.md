# Serve a local workspace console from the Python control plane

The Producer includes a loopback-only Workspace Console for Workspace configuration, Source Checkout management, Production Run observation, review, Knowledge Bundle reading, Concept provenance, and grounded questions. The console is a Vite and React client built with shadcn Base UI and served as static assets by the Python process; it never reads SQLite or performs state transitions directly, and Next.js or TanStack Start do not introduce a second server-side authority. Remote multi-user administration, collaborative Markdown editing, and direct editing of derived Bundle pages remain outside the initial scope.

