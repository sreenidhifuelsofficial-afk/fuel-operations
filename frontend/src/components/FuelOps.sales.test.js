import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaleSection } from './FuelOps';

function okJson(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  };
}

function expectUrlContains(fetchMock, callIndex, parts) {
  const url = fetchMock.mock.calls[callIndex][0];
  for (const part of parts) {
    expect(url).toContain(part);
  }
}

describe('SaleSection (filters + pagination)', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.spyOn(window, 'alert').mockImplementation(() => {});
    jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    window.alert.mockRestore();
    window.open.mockRestore();
    global.fetch.mockReset();
  });

  test('changing draft dates does not fetch until Apply; pageSize affects Next offset', async () => {
    // Mount fetch (initial applied filters)
    global.fetch
      .mockResolvedValueOnce(okJson({ items: Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        sale_date: '2026-02-10',
        performed_at: '2026-02-10 10:00:00',
        from_unit_code: 'TRUCK-01',
        to_vehicle: 'V',
        sale_volume_liters: 1,
        lot_code_after: 'LOT',
        driver_name: null,
        performed_by: null,
        activity: 'SALE',
        trip: null,
      })) }))
      // Apply after changing dates
      .mockResolvedValueOnce(okJson({ items: [] }))
      // Page size change to 25 -> re-fetch immediately
      .mockResolvedValueOnce(okJson({ items: Array.from({ length: 26 }, (_, i) => ({
        id: 1000 + i,
        sale_date: '2026-02-04',
        performed_at: '2026-02-04 09:00:00',
        from_unit_code: 'TRUCK-01',
        to_vehicle: 'V',
        sale_volume_liters: 1,
        lot_code_after: 'LOT',
        driver_name: null,
        performed_by: null,
        activity: 'SALE',
        trip: null,
      })) }))
      // Next page -> offset 25
      .mockResolvedValueOnce(okJson({ items: [] }));

    render(
      <SaleSection
        token="token"
        units={[{ id: 1, unit_type: 'TRUCK', unit_code: 'TRUCK-01' }]}
        datums={[]}
        drivers={[]}
        refreshStock={() => {}}
      />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    // Change draft From/To but don't click Apply yet
    const fromInput = screen.getByLabelText(/From Date/i);
    const toInput = screen.getByLabelText(/To Date/i);

    await userEvent.clear(fromInput);
    await userEvent.type(fromInput, '2026-02-04');
    await userEvent.clear(toInput);
    await userEvent.type(toInput, '2026-02-06');

    // No additional fetch until Apply
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Click Apply -> should fetch with new from/to
    await userEvent.click(screen.getByRole('button', { name: /^Apply$/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expectUrlContains(global.fetch, 1, ['from=2026-02-04', 'to=2026-02-06']);

    // Change page size to 25 -> should fetch immediately with limit=26 (limit+1) offset=0
    const pageSizeSelect = screen.getByLabelText(/Page Size/i);
    await userEvent.selectOptions(pageSizeSelect, '25');

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
    expectUrlContains(global.fetch, 2, ['limit=26', 'offset=0']);

    // Next -> should fetch with offset=25 (page 2)
    await userEvent.click(screen.getByRole('button', { name: /^Next$/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(4));
    expectUrlContains(global.fetch, 3, ['limit=26', 'offset=25']);
  });
});
