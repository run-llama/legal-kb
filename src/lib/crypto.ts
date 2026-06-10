// lib/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const SECRET = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex') // 32-byte hex key

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, SECRET, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  // Store as iv:tag:encrypted (all base64)
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join(':')
}

export function decrypt(stored: string): string {
  const [iv, tag, encrypted] = stored
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv(ALGORITHM, SECRET, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}
