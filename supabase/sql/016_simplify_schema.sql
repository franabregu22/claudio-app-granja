-- Remove precio_actual from productos table
alter table productos drop column if exists precio_actual;

-- Remove precios_snapshot from pedidos table  
alter table pedidos drop column if exists precios_snapshot;

-- That's it. Users will enter precio_unitario manually in the form
-- precios_actuales and precios_historial tables stay as they are for reference
