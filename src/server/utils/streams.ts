export const parseStream = (s: any) => {
  let push_urls = [];
  let push_status = [];
  let inputs = [];
  try {
    push_urls = JSON.parse(s.push_urls || '[]');
  } catch (e) {
    console.error('Failed to parse push_urls for stream', s.id);
  }
  try {
    push_status = JSON.parse(s.push_status || '[]');
  } catch (e) {
    console.error('Failed to parse push_status for stream', s.id);
  }
  try {
    inputs = JSON.parse(s.inputs || '[]');
  } catch (e) {
    console.error('Failed to parse inputs for stream', s.id);
  }
  return {
    ...s,
    push_urls,
    push_status,
    inputs
  };
};
