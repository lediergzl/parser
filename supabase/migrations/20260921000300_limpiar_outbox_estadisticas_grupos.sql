-- Al cambiar el destino de estadísticas de grupos a canales,
-- no se deben reenviar publicaciones que quedaron pendientes en el outbox antiguo.
update public.whatsapp_estadisticas_outbox
set estado = 'omitido',
    ultimo_error = 'Cola anterior al cambio de estadísticas: destino de grupo reemplazado por canal WhatsApp.',
    actualizado_at = now()
where estado in ('pendiente', 'enviando');
