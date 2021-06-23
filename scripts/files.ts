import fs from "fs"
import path from "path"

export async function writeFile(filename: string, content: string): Promise<void> {
    const dir = path.dirname(filename)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
    }
    await fs.promises.writeFile(filename, content, "utf8")
}
