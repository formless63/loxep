import { createFileRoute } from '@tanstack/react-router';

/**
 * Avatar serving route (loxep-0oq): streams a Loxep-stored avatar's bytes
 * back by `media_objects.id`. Any signed-in user may fetch any avatar — see
 * `@/server/avatar`'s doc for why that isn't an ACL gap. All logic lives
 * there and is loaded dynamically, matching `/api/account/avatar`.
 */
export const Route = createFileRoute('/api/media/avatar/$mediaId')({
  server: {
    handlers: {
      GET: async ({ params }: { params: { mediaId: string } }) => {
        const { handleAvatarServe } = await import('@/server/avatar');
        return handleAvatarServe(params.mediaId);
      }
    }
  }
});
