/**
 * 根据环境变量生成 js/config.js
 * Vercel 部署时在 Build Command 中运行: node scripts/gen-config.js
 */
const fs = require('fs');
const path = require('path');
const apiUrl = process.env.VITE_API_URL || process.env.API_URL || '';
const out = path.join(__dirname, '../js/config.js');
const content = `// 自动生成 - 请勿直接编辑
window.SANLIN_CONFIG = {
  apiUrl: '${apiUrl.replace(/'/g, "\\'")}',
};
`;
fs.writeFileSync(out, content, 'utf8');
console.log('Generated js/config.js with apiUrl:', apiUrl || '(empty)');
