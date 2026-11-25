/**
 * 单实例锁（docs/architecture.md §2.1）：SOFIA_HOME/daemon.lock 记录 pid。
 * 避免两个 daemon 同写 timeline.db、抢 Telegram 长轮询。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

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
  const guard = new DatabaseSync(join(home, "daemon-lock.db"))
  try {
    // 进程退出时系统释放写锁。整个 daemon 生命周期都持有它；保留数据库文件以使各进程锁定同一文件。
    guard.exec("BEGIN IMMEDIATE")
    if (existsSync(path)) {
      const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        throw new Error(`Sofia daemon is already running (pid ${holder}); lock: ${path}`)
      }
      unlinkSync(path)
    }
    writeFileSync(path, String(pid), { flag: "wx" })
  } catch (e) {
    guard.close()
    if ((e as { errcode?: number }).errcode === 5) { // SQLITE_BUSY
      throw new Error(`Sofia daemon is already running; lock: ${path}`)
    }
    throw e
  }
  return () => {
    if (!guard.isOpen) return
    try {
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path)
    } finally {
      guard.close()
    }
  }
}
