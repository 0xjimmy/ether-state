import { InterfaceAbi } from 'ethers'

export const MulticallABI: InterfaceAbi = [
	'function aggregate(tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes[] returnData)',
	'function blockAndAggregate(tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)',
	'function getBlockHash(uint256 blockNumber) view returns (bytes32 blockHash)',
	'function getBlockNumber() view returns (uint256 blockNumber)',
	'function getCurrentBlockCoinbase() view returns (address coinbase)',
	'function getCurrentBlockDifficulty() view returns (uint256 difficulty)',
	'function getCurrentBlockGasLimit() view returns (uint256 gaslimit)',
	'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
	'function getEthBalance(address addr) view returns (uint256 balance)',
	'function getLastBlockHash() view returns (bytes32 blockHash)',
	'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
	'function tryBlockAndAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)'
]

export const TokenMetadataABI: InterfaceAbi = [
	'function decimals() returns (string)',
	'function symbol() returns (string)',
	'function balanceOf(address addr) returns (uint)',
]

export const ERC20ABI: InterfaceAbi = [
	...TokenMetadataABI,
	'event Transfer(address indexed from, address indexed to, uint256 value)',
	'event Approval(address indexed owner, address indexed spender, uint256 value)',
	'function totalSupply() external view returns(uint256)',
	'function balanceOf(address account) external view returns(uint256)',
	'function transfer(address to, uint256 amount) external returns(bool)',
	'function allowance(address owner, address spender) external view returns(uint256)',
	'function approve(address spender, uint256 amount) external returns(bool)',
	'function transferFrom(address from, address to, uint256 amount) external returns(bool)'
]

export const ERC165ABI: InterfaceAbi = [
	'function supportsInterface(bytes4 interfaceId) external view returns (bool)'
]

export const ERC721ABI: InterfaceAbi = [
	...TokenMetadataABI,
	...ERC165ABI,
	'function name() external view returns(string memory)',
	'function symbol() external view returns(string memory)',
	'function decimals() external view returns(uint8)',
	'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
	'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
	'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
	'function balanceOf(address owner) external view returns(uint256 balance)',
	'function ownerOf(uint256 tokenId) external view returns(address owner)',
	'function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external',
	'function safeTransferFrom(address from, address to, uint256 tokenId) external',
	'function transferFrom(address from, address to, uint256 tokenId) external',
	'function approve(address to, uint256 tokenId) external',
	'function setApprovalForAll(address operator, bool _approved) external',
	'function getApproved(uint256 tokenId) external view returns(address operator)',
	'function isApprovedForAll(address owner, address operator) external view returns(bool)'
]
