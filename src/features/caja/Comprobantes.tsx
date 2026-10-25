import { useState } from 'react';
import { FileText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { documentSignedUrl, type DocumentLinkRow, type ViewableDocument } from '../../target/documents';
import { errorMessage } from '../../target/messages';

const TIPO_LEIDO: Record<string, string> = {
  INVOICE_A: 'Factura A', INVOICE_B: 'Factura B', INVOICE_C: 'Factura C', INVOICE_M: 'Factura M', TICKET: 'Ticket', RECEIPT: 'Recibo', OTHER: 'Comprobante',
};

/**
 * ADR-025 stage 4: the originals of a record (WhatsApp receipt, ERP upload, cheque PDF). Each one opens through a
 * short-lived signed URL of its private bucket; nothing is public and nothing is downloaded in advance.
 */
export function Comprobantes({ docs, compacto = false }: { docs: (ViewableDocument | DocumentLinkRow)[] | undefined; compacto?: boolean }) {
  const [error, setError] = useState<unknown>(null);
  if (!docs || docs.length === 0) return null;
  // one entry per stored object (a purchase and its WhatsApp link may point to the same file)
  const unicos = docs.filter((d, i) => docs.findIndex((x) => x.storage_path === d.storage_path) === i);

  const abrir = async (d: ViewableDocument) => {
    setError(null);
    const ventana = window.open('', '_blank');   // opened synchronously: popup blockers allow it
    try {
      const url = await documentSignedUrl(supabase, d);
      if (ventana) { ventana.opener = null; ventana.location.href = url; } else window.location.assign(url);
    } catch (e) {
      ventana?.close();
      setError(e);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {unicos.map((d, i) => {
        const leido = 'read_document_type' in d && d.read_document_type ? `${TIPO_LEIDO[d.read_document_type] ?? d.read_document_type}${d.read_number ? ` ${d.read_number}` : ''}` : null;
        const origen = 'origin' in d && d.origin === 'WHATSAPP' ? 'WhatsApp' : null;
        return (
          <button key={d.storage_path} type="button" onClick={() => abrir(d)} title={d.file_name}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-stone-100 text-[#6B5D45] hover:bg-amber-100">
            <FileText className="w-3.5 h-3.5" />
            {compacto ? (unicos.length > 1 ? `${i + 1}` : 'Ver') : (leido ?? (d.content_type === 'application/pdf' ? 'PDF' : 'Foto'))}
            {!compacto && origen && <span className="text-[10px] text-[#2C5E3A]">· {origen}</span>}
          </button>
        );
      })}
      {error ? <span className="text-xs text-red-700">{errorMessage(error)}</span> : null}
    </span>
  );
}
