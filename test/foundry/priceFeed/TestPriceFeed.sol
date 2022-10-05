contract TestPriceFeed {
    function decimals() external view returns (uint8) {
        revert();
    }

    function getPrice(uint256 interval) external view returns (uint256) {
        revert();
    }

    function cacheTwap(uint256 interval) external returns (uint256) {
        revert();
    }
}
