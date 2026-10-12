import type { PostCard } from "../../types";

/**
 * A list of posts (M5-6): each one's title as a link, its date and its excerpt. The page's own title is the `h1`, so
 * each post's is an `h2`. An empty list says so instead of drawing an empty landmark.
 */
export function PostList({ posts, empty = "No posts yet." }: { posts: readonly PostCard[]; empty?: string }) {
  if (posts.length === 0) return <p className="forge-post-list__empty">{empty}</p>;
  return (
    <ul className="forge-post-list">
      {posts.map((post) => (
        <li key={post.href}>
          <article className="forge-post-card">
            <h2 className="forge-post-card__title">
              <a href={post.href}>{post.title || "Untitled"}</a>
            </h2>
            {post.date ? (
              <p className="forge-post-card__date">
                <time dateTime={post.date.iso}>{post.date.label}</time>
              </p>
            ) : null}
            {post.excerpt ? <p className="forge-post-card__excerpt">{post.excerpt}</p> : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
