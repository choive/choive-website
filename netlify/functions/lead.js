exports.handler = async (event) => {
  const data = JSON.parse(event.body);

  console.log("NEW LEAD:", data);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  };
};
