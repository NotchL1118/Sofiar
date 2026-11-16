/**
 * 单实例锁（docs/architecture.md §2.1）：SOFIA_HOME/daemon.lock 记录 pid。
 * 避免两个 daemon 同写 timeline.db、抢 Telegram 长轮询。
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 获取锁；已被存活进程占用则抛异常。返回释放函数。 */
export function acquireLock(home: string, pid = process.pid): () => void {
  const path = join(home, "daemon.lock")
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: "wx" })
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path)
        } catch {
          // 已不存在
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        throw new Error(`Sofia daemon is already running (pid ${holder}); lock: ${path}`)
      }
      unlinkSync(path) // 残留锁：持有者已不在
    }
  }
  throw new Error(`could not acquire ${path}`)
}
