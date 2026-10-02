export function formatActivityTimestamp(timestamp: number | undefined): string | undefined {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
	const date = new Date(timestamp);
	const hour = date.getHours() % 12 || 12;
	return `${hour}:${date.getMinutes().toString().padStart(2, "0")}`;
}
