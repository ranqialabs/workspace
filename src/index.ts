export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
