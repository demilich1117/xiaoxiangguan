export function pageBooks(books, page, size = 10) {
  return books.slice(page * size, (page + 1) * size);
}
