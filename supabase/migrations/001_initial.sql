-- Sanlin 3D Annotation - 初始 Schema

-- 模型表
CREATE TABLE IF NOT EXISTS models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 标注层表
CREATE TABLE IF NOT EXISTS annotation_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  owner_id TEXT,
  visible BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 标注表
CREATE TABLE IF NOT EXISTS annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id UUID REFERENCES annotation_layers(id) ON DELETE SET NULL,
  model_id UUID REFERENCES models(id) ON DELETE CASCADE,
  targets JSONB NOT NULL,  -- [{ meshId, faceIndices? }]
  label TEXT,
  category TEXT,
  color TEXT,
  author TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_annotations_model ON annotations(model_id);
CREATE INDEX IF NOT EXISTS idx_annotations_layer ON annotations(layer_id);
CREATE INDEX IF NOT EXISTS idx_layers_model ON annotation_layers(model_id);
