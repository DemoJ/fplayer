// CLI 重置用户密码，供忘记密码时使用：
//   容器内:  docker compose exec fplayer node dist-server/reset-password.js <用户名> <新密码>
//   宿主机:  npm run reset-password -- <用户名> <新密码>
// 会清除该用户的所有登录会话，重置后需使用新密码重新登录。
import { db } from "./db.js";
import { hashPassword } from "./security.js";

const [username, newPassword] = process.argv.slice(2);

function fail(message: string): never {
  console.error(`[重置密码失败] ${message}`);
  process.exit(1);
}

if (!username || !newPassword) {
  fail("用法: node dist-server/reset-password.js <用户名> <新密码>");
}
if (newPassword.length < 8) {
  fail(`新密码至少 8 位（当前 ${newPassword.length} 位）`);
}

const user = db.prepare("SELECT id, username FROM users WHERE username=?").get(username) as { id: number; username: string } | undefined;
if (!user) {
  fail(`用户「${username}」不存在`);
}

db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(newPassword), user.id);
db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
db.close();

console.log(`✓ 用户「${user.username}」密码已重置，其所有登录会话已失效，请用新密码重新登录。`);