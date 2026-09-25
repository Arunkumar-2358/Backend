import { formatDateTime } from "./dates";

export function timeAgo(d: Date, ref = new Date()): string {
  const s = Math.round((ref.getTime() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return formatDateTime(d);
}
