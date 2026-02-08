/**
 * Sanlin 3D Annotation API - Railway
 * 与 Supabase (DB + Storage) + Pusher (实时) 配合
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import Pusher from 'pusher';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3001;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

const frontendOrigin = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.replace(/\/$/, '')
  : '*';
app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '10mb' }));

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Pusher
const pusher = process.env.PUSHER_APP_ID
  ? new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER || 'us2',
      useTLS: true,
    })
  : null;

// Auth middleware - 验证 JWT，要求 Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: '请先登录' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: '请先登录' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: '请先登录' });
  }
}

// Health
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    supabase: !!supabase,
    pusher: !!pusher,
  });
});

// Models API (示例)
app.get('/api/models', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { data, error } = await supabase.from('models').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/models', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { name, url } = req.body;
  const { data, error } = await supabase.from('models').insert({ name, url }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/models/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { data, error } = await supabase.from('models').update({ name: name.trim() }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.delete('/api/models/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { data: model } = await supabase.from('models').select('url').eq('id', id).single();
  if (!model) return res.status(404).json({ error: 'Not found' });
  if (model.url === 'builtin://default') {
    return res.status(400).json({ error: 'Cannot delete default model' });
  }
  const { error } = await supabase.from('models').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true, id });
});

// 上传模型文件到 Supabase Storage，并创建模型记录
app.post('/api/models/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = file.originalname.split('.').pop() || 'glb';
  if (!['glb', 'gltf'].includes(ext.toLowerCase())) {
    return res.status(400).json({ error: 'Only .glb or .gltf files allowed' });
  }
  const name = req.body.name || file.originalname || '未命名模型';
  const path = `${crypto.randomUUID()}.${ext}`;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const hasModels = buckets?.some((b) => b.name === 'models');
    if (!hasModels) {
      const { error: createErr } = await supabase.storage.createBucket('models', {
        public: true,
        fileSizeLimit: 52428800,
        allowedMimeTypes: ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream'],
      });
      if (createErr) {
        return res.status(503).json({ error: 'Storage bucket "models" not found. Create it in Supabase Dashboard (Storage -> New bucket).' });
      }
    }
    const { error: uploadErr } = await supabase.storage
      .from('models')
      .upload(path, file.buffer, { contentType: file.mimetype || 'model/gltf-binary', upsert: false });
    if (uploadErr) {
      if (uploadErr.message?.includes('Bucket not found')) {
        return res.status(503).json({ error: 'Storage bucket "models" not found. Create it in Supabase Dashboard.' });
      }
      return res.status(500).json({ error: uploadErr.message });
    }
    const { data: { publicUrl } } = supabase.storage.from('models').getPublicUrl(path);
    const { data: model, error: dbErr } = await supabase.from('models').insert({ name, url: publicUrl }).select().single();
    if (dbErr) return res.status(500).json({ error: dbErr.message });
    res.json(model);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

// Annotations API (需登录)
app.get('/api/models/:modelId/annotations', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { modelId } = req.params;
  const { data, error } = await supabase
    .from('annotations')
    .select('*')
    .eq('model_id', modelId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// 批量替换标注
app.put('/api/models/:modelId/annotations', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { modelId } = req.params;
  const { annotations } = req.body;
  if (!Array.isArray(annotations)) return res.status(400).json({ error: 'annotations must be array' });
  const { error: delErr } = await supabase.from('annotations').delete().eq('model_id', modelId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  if (annotations.length === 0) return res.json([]);
  const rows = annotations.map((a) => ({
    model_id: modelId,
    targets: a.targets || [],
    label: a.label || '未命名',
    category: a.category || '',
    color: a.color || '#FF9900',
    author: a.author || '',
  }));
  const { data, error } = await supabase.from('annotations').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  if (pusher) pusher.trigger(`model-${modelId}`, 'annotations-synced', data).catch(console.error);
  res.json(data || []);
});

app.patch('/api/models/:modelId/annotations/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { modelId, id } = req.params;
  const { label, category, color, targets } = req.body;
  const updates = {};
  if (label !== undefined) updates.label = label;
  if (category !== undefined) updates.category = category;
  if (color !== undefined) updates.color = color;
  if (targets !== undefined) updates.targets = targets;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
  const { data, error } = await supabase
    .from('annotations')
    .update(updates)
    .eq('id', id)
    .eq('model_id', modelId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  if (pusher) pusher.trigger(`model-${modelId}`, 'annotation-updated', data).catch(console.error);
  res.json(data);
});

app.delete('/api/models/:modelId/annotations/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { modelId, id } = req.params;
  const { data, error } = await supabase
    .from('annotations')
    .delete()
    .eq('id', id)
    .eq('model_id', modelId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (pusher) pusher.trigger(`model-${modelId}`, 'annotation-deleted', { id }).catch(console.error);
  res.json({ deleted: true, id });
});

app.post('/api/models/:modelId/annotations', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { modelId } = req.params;
  const { targets, label, category, color, author, layer_id } = req.body;
  const body = {
    model_id: modelId,
    targets: targets || [],
    label: label || '未命名',
    category: category || '',
    color: color || '#FF9900',
    author: author || '',
    ...(layer_id && { layer_id }),
  };
  const { data, error } = await supabase.from('annotations').insert(body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (pusher) {
    pusher.trigger(`model-${modelId}`, 'annotation-created', data).catch(console.error);
  }
  res.json(data);
});

// Pusher auth (前端订阅私有 channel 时用)
app.post('/api/pusher/auth', (req, res) => {
  if (!pusher) return res.status(503).json({ error: 'Pusher not configured' });
  const { socket_id, channel_name } = req.body;
  const auth = pusher.authorizeChannel(socket_id, channel_name);
  res.send(auth);
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
