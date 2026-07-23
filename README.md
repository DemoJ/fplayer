# FPlayer

面向个人 NAS 的自托管 Web 媒体播放器，支持本地目录与 WebDAV 媒体源。

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

浏览器会优先直接播放兼容格式；无法直接播放时自动启动 FFmpeg，转为 H.264 + AAC 的 HLS 流。

## 本地开发

```bash
npm install
npm run dev
```

开发地址：`http://localhost:5173`

## NAS 部署

1. 修改 `docker-compose.yml` 中的 `APP_SECRET`。
2. 如果使用 NAS 本地目录，挂载目录到容器内，例如 `/media`，并在媒体源中填写容器内路径。
3. 启动：

```bash
docker compose up -d --build
```

4. 打开 `http://NAS-IP:3000`，创建管理员。
5. 添加 WebDAV 地址或容器内本地目录，点击“测试”和“扫描”。

数据默认保存在项目目录的 `data/` 下，包含 SQLite 数据库和加密后的媒体源凭证。请定期备份该目录。
