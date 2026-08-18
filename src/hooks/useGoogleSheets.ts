import { useState } from 'react';

interface SheetData {
  values: string[][];
  range: string;
}

interface Sheet {
  title: string;
  sheetId: number;
}

export function useGoogleSheets() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parsea el ID del Sheet desde una URL
  const extractSheetId = (urlOrId: string): string => {
    const urlMatch = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (urlMatch) return urlMatch[1];
    return urlOrId;
  };

  // Obtiene la lista de hojas del spreadsheet
  const getSheets = async (accessToken: string, spreadsheetId: string): Promise<Sheet[]> => {
    try {
      setLoading(true);
      setError(null);

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?access_token=${accessToken}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Error al obtener hojas: ${response.statusText}`);
      }

      const data = await response.json();
      const sheets = data.sheets?.map((s: any) => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId,
      })) || [];

      return sheets;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Lee datos de un Sheet usando Google Sheets API v4
  const readSheet = async (
    accessToken: string,
    sheetId: string,
    range: string = 'A1:Z1000'
  ): Promise<SheetData> => {
    try {
      setLoading(true);
      setError(null);

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?access_token=${accessToken}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Error al leer Sheet: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.values || data.values.length === 0) {
        throw new Error('No se encontraron datos en el rango especificado');
      }

      return {
        values: data.values,
        range: data.range,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return {
    readSheet,
    getSheets,
    extractSheetId,
    loading,
    error,
    setError,
  };
}
