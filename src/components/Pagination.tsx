import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        className="p-2 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed rounded transition"
      >
        <ChevronLeft size={20} className="text-gray-600" />
      </button>

      <div className="text-sm text-gray-600">
        Página <span className="font-semibold">{currentPage}</span> de <span className="font-semibold">{totalPages}</span>
      </div>

      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="p-2 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed rounded transition"
      >
        <ChevronRight size={20} className="text-gray-600" />
      </button>
    </div>
  );
}
