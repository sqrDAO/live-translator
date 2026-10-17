/**
 * Vercel serverless sign-in endpoint: GET the Firebase web config, POST (with
 * a Firebase ID token) to learn — and on first sign-in, request — access. The
 * decision lives in `./_auth.ts`, shared with the reference host's Express
 * server.
 */

import { handleSessionRequest } from './_auth.js'

interface ServerlessRequest {
  method?: string | undefined
  headers: Record<string, string | string[] | undefined>
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse
  setHeader(name: string, value: string): unknown
  json(body: unknown): unknown
}

export default async function handler(req: ServerlessRequest, res: ServerlessResponse): Promise<void> {
  const authorization = req.headers['authorization']
  const result = await handleSessionRequest({
    method: req.method,
    authorization: Array.isArray(authorization) ? authorization[0] : authorization,
    host: null,
    // Never on a deployment: the bypass is a local-development convenience.
    developmentEnvironment: false,
    env: process.env,
  })
  // An access answer is per-person; no shared cache may keep one.
  res.setHeader('Cache-Control', 'no-store')
  res.status(result.status).json(result.body)
}
