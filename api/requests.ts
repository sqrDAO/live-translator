/**
 * Vercel serverless endpoint for admins: GET lists access requests, POST
 * `{ uid, status }` approves or denies one. The decision lives in
 * `./_auth.ts`; the Firestore rules decide who counts as an admin.
 */

import { handleRequestsRequest } from './_auth.js'

interface ServerlessRequest {
  method?: string | undefined
  body?: unknown
  headers: Record<string, string | string[] | undefined>
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse
  setHeader(name: string, value: string): unknown
  json(body: unknown): unknown
}

export default async function handler(req: ServerlessRequest, res: ServerlessResponse): Promise<void> {
  const authorization = req.headers['authorization']
  const result = await handleRequestsRequest({
    method: req.method,
    body: req.body,
    authorization: Array.isArray(authorization) ? authorization[0] : authorization,
    host: null,
    developmentEnvironment: false,
    env: process.env,
  })
  res.setHeader('Cache-Control', 'no-store')
  res.status(result.status).json(result.body)
}
