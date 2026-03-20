import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { toast } from 'react-hot-toast';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  ArrowLeft, Save, Loader2, Languages, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, Download, Eye, EyeOff, Move, GripVertical,
  Minus, Maximize2
} from 'lucide-react';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

const API_BASE = '/api';

// Draggable overlay box component
function DraggableBox({ segment, scale, onMove, onEdit, onTranslate, translating, visible }) {
  const boxRef = useRef(null);
  const [minimized, setMinimized] = useState(false);
  const dragState = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const handleMouseDown = (e) => {
    if (e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: segment.overlayX,
      origY: segment.overlayY,
    };

    const handleMouseMove = (ev) => {
      if (!dragState.current.dragging) return;
      const dx = (ev.clientX - dragState.current.startX) / scale;
      const dy = (ev.clientY - dragState.current.startY) / scale;
      onMove(segment.id, dragState.current.origX + dx, dragState.current.origY + dy);
    };

    const handleMouseUp = () => {
      dragState.current.dragging = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  if (!visible || !segment.translation) return null;

  const style = {
    position: 'absolute',
    left: `${segment.overlayX * scale}px`,
    top: `${segment.overlayY * scale}px`,
    width: minimized ? 'auto' : `${segment.overlayW * scale}px`,
    minHeight: minimized ? 'auto' : `${segment.overlayH * scale}px`,
  };

  return (
    <div
      ref={boxRef}
      style={style}
      className={`group border rounded shadow-md hover:shadow-lg transition-shadow z-10 ${
        minimized
          ? 'bg-yellow-200/90 border-yellow-500/70'
          : 'bg-yellow-50/95 border-yellow-400/70 hover:border-yellow-500'
      }`}
    >
      {/* Drag handle + controls */}
      <div
        onMouseDown={handleMouseDown}
        className="flex items-center gap-1 px-1.5 py-0.5 bg-yellow-100/80 border-b border-yellow-300/50 cursor-move rounded-t select-none"
      >
        <GripVertical className="h-3 w-3 text-yellow-600/70" />
        <span className="text-[9px] text-yellow-700/70 font-medium truncate flex-1">
          {segment.id}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onTranslate(segment.id); }}
          disabled={translating}
          className="p-0.5 text-blue-600 hover:bg-blue-100 rounded disabled:opacity-50"
          title="Retraduzir"
        >
          {translating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Languages className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
          className="p-0.5 text-yellow-700 hover:bg-yellow-200 rounded"
          title={minimized ? 'Expandir' : 'Minimizar'}
        >
          {minimized ? (
            <Maximize2 className="h-3 w-3" />
          ) : (
            <Minus className="h-3 w-3" />
          )}
        </button>
      </div>
      {/* Editable translation - hidden when minimized */}
      {!minimized && (
        <textarea
          value={segment.translation}
          onChange={(e) => onEdit(segment.id, e.target.value)}
          className="w-full bg-transparent text-[11px] leading-snug text-gray-900 p-1.5 resize-none outline-none"
          style={{
            minHeight: `${Math.max(20, (segment.overlayH * scale) - 20)}px`,
            fontSize: `${Math.max(9, Math.min(13, segment.fontSize * scale * 0.85))}px`,
          }}
        />
      )}
    </div>
  );
}

export default function DocumentEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { token } = useAuthStore();

  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.5);
  const [segments, setSegments] = useState([]);
  const [translatingId, setTranslatingId] = useState(null);
  const [translatingAll, setTranslatingAll] = useState(false);
  const [showOverlays, setShowOverlays] = useState(true);
  const [documentContext, setDocumentContext] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const renderTaskRef = useRef(null);

  // Fetch document
  useEffect(() => {
    const fetchDocument = async () => {
      try {
        const response = await fetch(`${API_BASE}/documents/${id}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Document not found');
        const data = await response.json();
        setDoc(data.document);
        if (data.document.segments && data.document.segments.length > 0) {
          setSegments(data.document.segments);
        }
      } catch (error) {
        toast.error('Erro ao carregar documento');
        navigate('/');
      } finally {
        setLoading(false);
      }
    };
    fetchDocument();
  }, [id, token, navigate]);

  // Load PDF (both pdfjs and raw bytes for export)
  useEffect(() => {
    if (!doc) return;

    const loadPdf = async () => {
      try {
        const url = `${API_BASE}/files/${doc.file_path}`;
        const resp = await fetch(url);
        const buffer = await resp.arrayBuffer();
        setPdfBytes(new Uint8Array(buffer));

        const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
      } catch (error) {
        console.error('PDF load error:', error);
        toast.error('Erro ao carregar PDF');
      }
    };
    loadPdf();
  }, [doc]);

  // Render page
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current) return;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    try {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderTask = page.render({
        canvasContext: context,
        viewport,
      });
      renderTaskRef.current = renderTask;
      await renderTask.promise;
    } catch (error) {
      if (error.name !== 'RenderingCancelledException') {
        console.error('Render error:', error);
      }
    }
  }, [pdfDoc, currentPage, scale]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Extract text WITH positions from current page
  const extractPageText = async () => {
    if (!pdfDoc) return;

    try {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale: 1 }); // scale=1 for base coords
      const textContent = await page.getTextContent();

      // Group items into lines by Y position
      const lineMap = new Map();
      for (const item of textContent.items) {
        if (!item.str.trim()) continue;
        const y = Math.round(item.transform[5]);
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y).push(item);
      }

      // Sort lines top to bottom (higher Y = higher on page in PDF coords)
      const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);

      // Group lines into paragraphs based on Y gap
      const paragraphs = [];
      let currentParagraph = { items: [], text: '' };
      let lastY = null;

      for (const y of sortedYs) {
        const lineItems = lineMap.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
        const lineText = lineItems.map(i => i.str).join(' ').trim();
        if (!lineText) continue;

        const gap = lastY !== null ? lastY - y : 0;
        const avgHeight = lineItems.reduce((s, i) => s + i.height, 0) / lineItems.length;

        // New paragraph if gap is large
        if (lastY !== null && gap > avgHeight * 1.8) {
          if (currentParagraph.text.trim()) {
            paragraphs.push({ ...currentParagraph });
          }
          currentParagraph = { items: [], text: '' };
        }

        currentParagraph.items.push(...lineItems);
        currentParagraph.text += (currentParagraph.text ? ' ' : '') + lineText;
        lastY = y;
      }
      if (currentParagraph.text.trim()) {
        paragraphs.push(currentParagraph);
      }

      // Build segments with overlay positions
      const pageHeight = viewport.height;
      const newSegments = paragraphs.map((para, i) => {
        const allItems = para.items;
        const xs = allItems.map(it => it.transform[4]);
        const ys = allItems.map(it => it.transform[5]);
        const heights = allItems.map(it => it.height);
        const widths = allItems.map(it => it.width);

        const minX = Math.min(...xs);
        const maxX = Math.max(...xs.map((x, j) => x + widths[j]));
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys.map((y, j) => y + heights[j]));
        const avgFontSize = heights.reduce((s, h) => s + h, 0) / heights.length;

        // PDF coords: origin bottom-left. Canvas: origin top-left.
        const overlayX = minX;
        const overlayY = pageHeight - maxY;
        const overlayW = maxX - minX;
        const overlayH = maxY - minY + avgFontSize * 0.5;

        return {
          id: `p${currentPage}-s${i}`,
          page: currentPage,
          source: para.text.trim(),
          translation: '',
          status: 'pending',
          overlayX,
          overlayY,
          overlayW: Math.max(overlayW, 100),
          overlayH: Math.max(overlayH, 20),
          fontSize: avgFontSize,
          // Store PDF-space coords for export
          pdfX: minX,
          pdfY: minY,
          pdfW: maxX - minX,
          pdfH: maxY - minY,
        };
      });

      // Merge with existing segments
      setSegments((prev) => {
        const otherPages = prev.filter((s) => s.page !== currentPage);
        return [...otherPages, ...newSegments].sort((a, b) => {
          if (a.page !== b.page) return a.page - b.page;
          return (a.overlayY || 0) - (b.overlayY || 0);
        });
      });

      toast.success(`${newSegments.length} segmentos extraídos da página ${currentPage}`);

      // Auto-analyze document type if not yet analyzed
      if (!documentContext) {
        const allText = newSegments.map(s => s.source).join('\n');
        analyzeDocument(allText);
      }
    } catch (error) {
      toast.error('Erro ao extrair texto');
      console.error(error);
    }
  };

  // Analyze document type for better translation context
  const analyzeDocument = async (text) => {
    if (!doc || !text) return;
    setAnalyzing(true);
    try {
      const response = await fetch(`${API_BASE}/analyze-document`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          sourceLanguage: doc.source_language,
        }),
      });

      if (!response.ok) throw new Error('Analysis failed');

      const analysis = await response.json();
      setDocumentContext(analysis);

      const typeLabels = {
        birth_certificate: 'Certidão de Nascimento',
        death_certificate: 'Certidão de Óbito',
        marriage_certificate: 'Certidão de Casamento',
        criminal_record: 'Antecedentes Criminais',
        school_document: 'Documento Escolar',
        university_diploma: 'Diploma Universitário',
        power_of_attorney: 'Procuração',
        deed: 'Escritura',
        immigration_form: 'Formulário de Imigração',
        support_letter: 'Carta de Apoio',
        medical_record: 'Documento Médico',
        financial_document: 'Documento Financeiro',
        identity_document: 'Documento de Identidade',
        other: 'Outro',
      };

      toast.success(`Documento identificado: ${typeLabels[analysis.documentType] || analysis.documentType}`);
    } catch (error) {
      console.error('Analysis error:', error);
    } finally {
      setAnalyzing(false);
    }
  };

  // Move overlay box
  const handleMoveBox = (segId, newX, newY) => {
    setSegments((prev) =>
      prev.map((s) => s.id === segId ? { ...s, overlayX: newX, overlayY: newY } : s)
    );
  };

  // Edit translation
  const handleEditTranslation = (segId, value) => {
    setSegments((prev) =>
      prev.map((s) => s.id === segId ? { ...s, translation: value } : s)
    );
  };

  // Translate single segment by ID
  const translateSegment = async (segId) => {
    const seg = segments.find(s => s.id === segId);
    if (!seg || !seg.source) return;

    setTranslatingId(segId);
    try {
      const response = await fetch(`${API_BASE}/translate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: seg.source,
          sourceLanguage: doc.source_language,
          targetLanguage: doc.target_language,
          documentContext: documentContext || undefined,
        }),
      });

      if (!response.ok) throw new Error('Translation failed');

      const data = await response.json();
      setSegments((prev) =>
        prev.map((s) =>
          s.id === segId ? { ...s, translation: data.translatedText, status: 'translated' } : s
        )
      );
    } catch (error) {
      toast.error('Erro na tradução');
      console.error(error);
    } finally {
      setTranslatingId(null);
    }
  };

  // Translate all pending on current page
  const translateAll = async () => {
    const pending = segments.filter(
      (s) => s.page === currentPage && s.status === 'pending' && s.source
    );

    if (pending.length === 0) {
      toast('Nenhum segmento pendente nesta página');
      return;
    }

    setTranslatingAll(true);
    let translated = 0;

    for (const seg of pending) {
      setTranslatingId(seg.id);
      try {
        const response = await fetch(`${API_BASE}/translate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: seg.source,
            sourceLanguage: doc.source_language,
            targetLanguage: doc.target_language,
            documentContext: documentContext || undefined,
          }),
        });

        if (!response.ok) continue;

        const data = await response.json();
        setSegments((prev) =>
          prev.map((s) =>
            s.id === seg.id ? { ...s, translation: data.translatedText, status: 'translated' } : s
          )
        );
        translated++;
      } catch (error) {
        console.error(error);
      }
    }

    setTranslatingId(null);
    setTranslatingAll(false);
    toast.success(`${translated} segmentos traduzidos`);
  };

  // Save segments to server
  const saveSegments = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/documents/${id}/segments`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ segments }),
      });

      if (!response.ok) throw new Error('Save failed');
      toast.success('Traduções salvas!');
    } catch (error) {
      toast.error('Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  // Helper: wrap text into lines that fit within maxWidth
  const wrapText = (text, font, fontSize, maxWidth) => {
    const lines = [];
    // Split by newlines first
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      const words = para.split(' ').filter(w => w);
      if (words.length === 0) { lines.push(''); continue; }
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);
        if (testWidth > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);
    }
    return lines;
  };

  // Export PDF with translations overlaid
  const exportPdf = async () => {
    if (!pdfBytes) return;

    setExporting(true);
    try {
      const pdfDocLib = await PDFDocument.load(pdfBytes);
      const font = await pdfDocLib.embedFont(StandardFonts.Helvetica);
      const pages = pdfDocLib.getPages();

      // Get page dimensions for margin reference
      const pageSize = pages[0]?.getSize();
      const pageWidth = pageSize?.width || 612;

      for (const seg of segments) {
        if (!seg.translation || seg.pdfX == null) continue;

        const pageIdx = seg.page - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) continue;

        const page = pages[pageIdx];
        const { width: pw, height: ph } = page.getSize();

        // Use original font size, clamped
        const fontSize = Math.max(7, Math.min(13, seg.fontSize || 10));
        const lineHeight = fontSize * 1.35;

        // Use full available width from segment X to right margin (with padding)
        const rightMargin = 40;
        const maxWidth = Math.max(seg.pdfW, pw - seg.pdfX - rightMargin);

        // Wrap the translated text
        const lines = wrapText(seg.translation, font, fontSize, maxWidth);
        const totalTextHeight = lines.length * lineHeight;

        // The rectangle must cover the original text AND fit all translated lines
        const rectHeight = Math.max(seg.pdfH + 4, totalTextHeight + 4);
        const rectY = seg.pdfY + seg.pdfH - rectHeight + 2;
        const rectWidth = Math.max(seg.pdfW, maxWidth) + 4;

        // Draw white background to cover original text
        page.drawRectangle({
          x: seg.pdfX - 2,
          y: rectY,
          width: rectWidth,
          height: rectHeight,
          color: rgb(1, 1, 1),
        });

        // Draw each line from top of the original text position downward
        const startY = seg.pdfY + seg.pdfH;
        lines.forEach((line, lineIdx) => {
          const y = startY - (lineIdx + 1) * lineHeight;
          if (y > 0) {
            page.drawText(line, {
              x: seg.pdfX,
              y,
              size: fontSize,
              font,
              color: rgb(0, 0, 0),
            });
          }
        });
      }

      const exportedBytes = await pdfDocLib.save();
      const blob = new Blob([exportedBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${doc.filename.replace('.pdf', '')}_traduzido.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('PDF exportado com sucesso!');
    } catch (error) {
      toast.error('Erro ao exportar PDF');
      console.error(error);
    } finally {
      setExporting(false);
    }
  };

  const pageSegments = segments.filter((s) => s.page === currentPage);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Toolbar */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </button>
          <div>
            <h1 className="text-sm font-semibold text-gray-900 truncate max-w-xs">
              {doc?.filename}
            </h1>
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-500">
                {doc?.source_language} → {doc?.target_language}
              </p>
              {analyzing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700">
                  <Loader2 className="h-3 w-3 animate-spin" /> Analisando...
                </span>
              )}
              {documentContext && !analyzing && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-700" title={documentContext.context}>
                  {documentContext.documentType?.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Zoom */}
          <button onClick={() => setScale((s) => Math.max(0.5, s - 0.25))} className="p-2 hover:bg-gray-100 rounded-lg">
            <ZoomOut className="h-4 w-4 text-gray-600" />
          </button>
          <span className="text-xs text-gray-500 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(3, s + 0.25))} className="p-2 hover:bg-gray-100 rounded-lg">
            <ZoomIn className="h-4 w-4 text-gray-600" />
          </button>

          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Pages */}
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-2 hover:bg-gray-100 rounded-lg disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-gray-600 w-20 text-center">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="p-2 hover:bg-gray-100 rounded-lg disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Toggle overlays */}
          <button
            onClick={() => setShowOverlays(!showOverlays)}
            className={`p-2 rounded-lg transition-colors ${showOverlays ? 'bg-yellow-100 text-yellow-700' : 'hover:bg-gray-100 text-gray-500'}`}
            title={showOverlays ? 'Ocultar traduções' : 'Mostrar traduções'}
          >
            {showOverlays ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>

          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Actions */}
          <button
            onClick={extractPageText}
            className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Extrair texto
          </button>

          <button
            onClick={translateAll}
            disabled={translatingAll}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            {translatingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
            Traduzir
          </button>

          <button
            onClick={saveSegments}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Salvar
          </button>

          <button
            onClick={exportPdf}
            disabled={exporting || segments.filter(s => s.translation).length === 0}
            className="px-3 py-1.5 text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Exportar PDF
          </button>
        </div>
      </header>

      {/* Main: PDF with overlays */}
      <div className="flex-1 overflow-auto bg-gray-300 flex justify-center p-6">
        <div ref={containerRef} className="relative inline-block shadow-xl">
          <canvas ref={canvasRef} className="block" />

          {/* Floating translation overlays */}
          {showOverlays && pageSegments.map((seg) => (
            <DraggableBox
              key={seg.id}
              segment={seg}
              scale={scale}
              visible={showOverlays}
              translating={translatingId === seg.id}
              onMove={handleMoveBox}
              onEdit={handleEditTranslation}
              onTranslate={translateSegment}
            />
          ))}
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="bg-white border-t border-gray-200 px-4 py-2 flex items-center justify-between text-xs text-gray-500 flex-shrink-0">
        <div className="flex items-center gap-4">
          <span>{pageSegments.length} segmentos na página</span>
          <span>{pageSegments.filter(s => s.status === 'translated').length} traduzidos</span>
        </div>
        <div className="flex items-center gap-1">
          <Move className="h-3 w-3" />
          <span>Arraste as caixas amarelas para reposicionar</span>
        </div>
      </div>
    </div>
  );
}
