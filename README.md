# 3D 模型标注 Demo

最小可运行的 3D 模型加载、选择与标注本地 Demo。  
支持 glTF/GLB 加载、mesh 级射线选择、简单标注层。

## 运行方式

需通过本地 HTTP 服务器运行（避免 CORS 与 ES Module 限制）：

```bash
# 方式 1：npx serve（推荐）
npx serve .

# 方式 2：Python
python3 -m http.server 3000

# 方式 3：Node.js http-server
npx http-server -p 3000
```

浏览器访问 `http://localhost:3000`（或对应端口）。

## 功能说明

1. **加载模型**
   - 点击「加载示例建筑」：使用内置的立方体建筑模型
   - 选择 glTF/GLB 文件：加载自定义模型

2. **选择**
   - 单击 mesh：单选
   - Shift + 单击：多选 / 取消选择

3. **标注**
   - 选择 mesh 后，在右侧输入标签、分类、颜色，点击「添加标注」
   - 标注会以指定颜色高亮对应 mesh
   - 点击标注列表中的条目可重新聚焦到对应 mesh

## 项目结构

```
.
├── index.html
├── styles.css
├── js/main.js
├── vercel.json           # Vercel 前端配置
├── backend/              # Railway API
│   ├── package.json
│   └── src/index.js
├── supabase/migrations/  # 数据库 schema
├── README.md
└── DEPLOYMENT.md         # 上线部署指南 (Vercel + Railway + Supabase + Pusher)
```

## 保存/加载标注

部署后，在 Vercel 环境变量中设置 `VITE_API_URL` 为 Railway API 地址，即可使用「保存标注」和「加载标注」将数据持久化到 Supabase。仅对「示例建筑」生效。

在线部署见 [DEPLOYMENT.md](./DEPLOYMENT.md)。
