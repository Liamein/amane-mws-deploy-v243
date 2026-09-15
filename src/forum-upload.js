export function shouldImmediatelyForwardForumUpload(attachments) {
  const files = Array.from(attachments || []);
  return files.length > 0;
}
