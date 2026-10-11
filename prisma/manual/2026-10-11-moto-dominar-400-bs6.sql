-- sin-transaccion
-- Moto nueva en el catálogo: Dominar 400 BS6 (ver MOTO_MODELS en lib/modelo.ts).
-- Product.compatibleModels es texto y no la necesita; el valor va al enum porque
-- lib/modelo.ts exige que su tabla y MotoModel coincidan (ScrapedProduct.model lo usa).
ALTER TYPE "MotoModel" ADD VALUE IF NOT EXISTS 'DOMINAR_400_BS6';
