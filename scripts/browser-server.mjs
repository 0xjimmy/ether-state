import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

createServer(async (request, response) => {
  const file = request.url === '/' ? 'index.html' : request.url === '/bundle.js' ? 'bundle.js' : undefined
  if (file === undefined) { response.writeHead(404).end(); return }
  try {
    const body = await readFile(new URL(`../.tmp/package/${file}`, import.meta.url))
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body)
  } catch { response.writeHead(500).end() }
}).listen(4179, '127.0.0.1')
