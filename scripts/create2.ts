import crypto from "crypto"

export function generateSalt(): string {
    return "0x" + crypto.randomBytes(32).toString("hex")
}
