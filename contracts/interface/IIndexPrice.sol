pragma solidity 0.7.6;

interface IIndexPrice {
    function getIndexPrice(uint256 interval) external view returns (uint256);
}
