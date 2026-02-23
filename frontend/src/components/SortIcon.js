import React from 'react';

function SortIcon({ dir, active }) {
	let symbol = '♦';
	let opacity = 0.35;
	if (active && dir) {
		symbol = dir === 'asc' ? '▲' : '▼';
		opacity = 0.75;
	}
	return (
		<span style={{ marginLeft: 6, fontSize: 10, opacity }} aria-hidden>
			{symbol}
		</span>
	);
}

export default SortIcon;
