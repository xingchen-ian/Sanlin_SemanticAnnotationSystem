/**
 * 根据环境变量生成 js/config.js
 * Vercel 部署时在 Build Command 中运行: node scripts/gen-config.js
 */
const fs = require('fs');
const path = require('path');
const apiUrl = process.env.VITE_API_URL || process.env.API_URL || '';
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const pusherKey = process.env.VITE_PUSHER_KEY || process.env.PUSHER_KEY || '';
const pusherCluster = process.env.VITE_PUSHER_CLUSTER || process.env.PUSHER_CLUSTER || 'us2';
const out = path.join(__dirname, '../js/config.js');
const content = `// 自动生成 - 请勿直接编辑
window.SANLIN_CONFIG = {
  apiUrl: '${apiUrl.replace(/'/g, "\\'")}',
  supabaseUrl: '${supabaseUrl.replace(/'/g, "\\'")}',
  supabaseAnonKey: '${supabaseAnonKey.replace(/'/g, "\\'")}',
  pusherKey: '${pusherKey.replace(/'/g, "\\'")}',
  pusherCluster: '${pusherCluster.replace(/'/g, "\\'")}',
};
`;
fs.writeFileSync(out, content, 'utf8');
console.log('Generated js/config.js with apiUrl:', apiUrl || '(empty)');
