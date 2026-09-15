const mode = process.argv[2] ?? "transfers"
if (mode === "transfers") await import("./erc20-transfers.js")
else if (mode === "v3") await import("./uniswap-v3.js")
else throw new Error("Use transfers or v3")

export {}
