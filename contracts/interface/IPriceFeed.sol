pragma solidity 0.7.6;

interface IPriceFeed {
    function decimals() external view returns (uint8);

    function getPrice() external view returns (uint256);

    function getTwapPrice(uint256 interval) external view returns (uint256);
}
