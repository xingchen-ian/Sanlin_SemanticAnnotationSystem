# 部署指南 - Vercel + Railway + Supabase + Pusher

## 架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Vercel    │     │   Railway   │     │  Supabase   │
│  (前端)     │────▶│  (API)      │────▶│  (数据库)   │
└─────────────┘     └──────┬──────┘     └─────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │   Pusher    │
                   │  (实时)     │
                   └─────────────┘
```

## 1. Supabase

1. 访问 [supabase.com](https://supabase.com) 创建项目
2. 在 SQL Editor 中执行 `supabase/migrations/001_initial.sql`
3. 在 Settings → API 中复制 `Project URL` 和 `service_role` key

## 2. Pusher

1. 访问 [pusher.com](https://pusher.com) 创建 Channels 应用
2. 选择集群（如 us2）
3. 复制 App ID、Key、Secret、Cluster

## 3. Railway (后端 API)

1. 访问 [railway.app](https://railway.app)，用 GitHub 登录
2. New Project → Deploy from GitHub → 选择本仓库
3. 设置 Root Directory 为 `backend`
4. 在 Variables 中添加：

   | 变量 | 值 |
   |------|-----|
   | SUPABASE_URL | 你的 Supabase URL |
   | SUPABASE_SERVICE_KEY | 你的 service_role key |
   | PUSHER_APP_ID | Pusher App ID |
   | PUSHER_KEY | Pusher Key |
   | PUSHER_SECRET | Pusher Secret |
   | PUSHER_CLUSTER | 如 us2 |
   | FRONTEND_URL | 前端 Vercel 地址（部署后填写） |

5. 部署后复制生成的公网 URL（如 `https://xxx.railway.app`）

## 4. Vercel (前端)

1. 访问 [vercel.com](https://vercel.com)，用 GitHub 登录
2. Import 本仓库
3. 设置 Root Directory 为 `.`（根目录）
4. 在 Environment Variables 中添加：

   | 变量 | 值 |
   |------|-----|
   | VITE_API_URL | Railway API URL（如 https://xxx.railway.app） |

5. 确保 Build Command 为 `node scripts/gen-config.js`（vercel.json 已配置）

5. 部署

## 5. 配置 CORS

Railway 部署后，在 FRONTEND_URL 中填入 Vercel 的域名（如 `https://your-app.vercel.app`），确保 CORS 允许前端请求。

## 项目结构

```
.
├── index.html
├── js/main.js
├── styles.css
├── vercel.json           # Vercel 配置
├── backend/              # Railway 部署
│   ├── package.json
│   ├── .env.example
│   └── src/
│       └── index.js
├── supabase/
│   └── migrations/
│       └── 001_initial.sql
└── DEPLOYMENT.md
```
