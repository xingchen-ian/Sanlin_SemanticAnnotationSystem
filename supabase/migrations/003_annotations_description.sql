-- 标注表增加「描述」字段：支持 500 字以内文本描述该标注（WorldBox）包含的模型结构
ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN annotations.description IS '文本描述，500字以内，描述该标注（WorldBox）包含的模型结构';
