pragma solidity 0.8.4;
import "../lib/UniswapBroker.sol";

contract TestUniswapBroker {
    function mint(
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 base,
        uint256 quote
    )
        internal
        returns (
            uint256 addedBase,
            uint256 addedQuote,
            uint256 liquidityDelta,
            uint256 feeGrowthInsideLastBase,
            uint256 feeGrowthInsideLastQuote
        )
    {
        return UniswapBroker.mint(pool, tickLower, tickUpper, base, quote);
    }
}
