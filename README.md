# FPlayer

面向个人 NAS 的自托管 Web 媒体播放器，支持本地目录与 WebDAV 媒体源。

> [!WARNING]
> **部署前必读：必须修改 `APP_SECRET`**
>
> `docker-compose.yml` 中硬编码的 `APP_SECRET` 是项目作者本人的自用密钥，
> **已随公开仓库对外可见**。任何拿到该密钥的人，一旦同时获得你的数据库文件
> （`data/` 目录），就能解密你保存的所有 WebDAV 账号密码。
>
> 正式部署前**务必替换**，例如：
>
> ```bash
> openssl rand -hex 32   # 用生成结果替换 docker-compose.yml 中的 APP_SECRET
> ```
>
> 服务每次启动时也会在日志中检测并提醒。注意：替换密钥后，之前保存的
> WebDAV 密码将无法解密，需要重新填写一次。

## 当前 MVP

- 首次启动创建管理员账户
- 本地目录 / WebDAV 媒体源
- WebDAV 连接测试和递归扫描
- 电影 / 剧集基础识别
- 豆瓣元数据匹配（搜索 + 详情页解析、Cookie、防封禁、sec 验证）
- 媒体库、搜索、详情页
- 服务端媒体代理、HTTP Range 与 FFmpeg HLS 转码回退
- 播放进度和继续观看
- Docker 单容器部署

浏览器会优先直接播放兼容格式；无法直接播放时自动启动 FFmpeg，转为 H.264 + AAC 的 HLS 流。有 NVIDIA GPU 时默认自动启用 NVDEC/NVENC，无 GPU 或硬件编码不可用时回落到 CPU。

## 本地开发

```bash
npm install
npm run dev
```

开发地址：`http://localhost:5173`

## NAS 部署

1. **修改 `docker-compose.yml` 中的 `APP_SECRET`（必须）**：仓库里的值是作者自用密钥，已在 GitHub 公开，直接部署有被解密 WebDAV 凭证的风险。用 `openssl rand -hex 32` 生成随机密钥替换。
2. **旧版本升级**：容器现以非 root 用户（uid 1000）运行。若 `data/` 目录是老版本（root 所有）产生的，首次启动前执行一次 `sudo chown -R 1000:1000 data`。
3. 如果使用 NAS 本地目录，挂载目录到容器内，例如 `/media`，并在媒体源中填写容器内路径。
4. 启动：

```bash
docker compose up -d --build
```

GPU 转码需要宿主机安装 NVIDIA 驱动与 NVIDIA Container Toolkit。可通过 `TRANSCODE_ACCELERATION=cpu` 强制关闭硬件加速；默认 `auto` 会在容器启动后首次转码时检测 GPU。

5. 打开 `http://NAS-IP:3000`，创建管理员。
6. 添加 WebDAV 地址或容器内本地目录，点击“测试”和“扫描”。

数据默认保存在项目目录的 `data/` 下，包含 SQLite 数据库和加密后的媒体源凭证。请定期备份该目录。
