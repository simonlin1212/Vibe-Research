import { Skeleton, SkeletonTable } from "@/components/ui/Skeleton";

/** Suspense fallback for lazy route / tab panels. */
export function PageFallback() {
  return (
    <div className="space-y-4" role="status" aria-label="页面加载中">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-3.5 w-64" />
      <SkeletonTable rows={6} cols={5} className="border border-[#2a2a2a]" />
    </div>
  );
}
