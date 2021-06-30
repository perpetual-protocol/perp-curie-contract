pragma solidity 0.7.6;

interface IPriceFeed {
    function decimals() external view returns (uint8);

    function getPrice(uint256 interval) external view returns (uint256);
}
