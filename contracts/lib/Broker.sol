pragma solidity 0.7.3;

library UniswapBroker {
    function addLiquidity(
        address _pool,
        int24 _tickLower,
        int24 _tickUpper,
        uint256 _base,
        uint256 _quote
    )
        internal
        returns (
            uint256 base,
            uint256 quote,
            uint256 liquidityDelta,
            uint256 feeGrowthInsideLastBase,
            uint256 feeGrowthInsideLastQuote
        )
    {
        revert();
    }

    function removeLiquidity(
        address _pool,
        int24 _tickLower,
        int24 _tickUpper,
        uint256 _liquidity
    )
        internal
        returns (
            uint256 base,
            uint256 quote,
            uint256 liquidityDelta,
            uint256 feeGrowthInsideLastBase,
            uint256 ffeeGrowthInsideLastQuote
        )
    {
        revert();
    }

    function swap(
        address _pool,
        bool _baseToQuote,
        int256 _amount,
        uint96 sqrtPriceLimitX96
    ) internal returns (uint256 base, uint256 quote) {
        revert();
    }

    function collect(
        address _pool,
        int256 _tickLower,
        int256 _tickUpper
    ) internal returns (uint256 feeBase, uint256 feeQuote) {
        revert();
    }

    // view functions
    function getAmountsForLiquidity(
        address _pool,
        uint24 _tickLower,
        uint24 _tickUpper,
        uint256 _liquidty
    ) internal view returns (uint256 base, uint256 quote) {
        revert();
    }

    function getQuoteToBase(
        address _pool,
        bool _exactQuote,
        uint256 _amount
    ) internal view returns (uint256 base) {
        revert();
    }

    function getBaseToQuote(
        address _pool,
        bool _exactBase,
        uint256 _amount
    ) internal view returns (uint256 quote) {
        revert();
    }
}
