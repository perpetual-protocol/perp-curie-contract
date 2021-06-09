pragma solidity 0.8.4;
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

library UniswapV3Broker {
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

    function getPool(
        IUniswapV3Factory factory,
        IERC20 quoteToken,
        IERC20 baseToken,
        uint24 feeRatio
    ) internal view returns (IUniswapV3Pool) {
        (IERC20 token0, IERC20 token1) = getTokenOrder(quoteToken, baseToken);
        return IUniswapV3Pool(IUniswapV3Factory(factory).getPool(address(token0), address(token1), feeRatio));
    }

    // @dev in uniswapV3, the smaller value of the token address is token0, the other one is token1
    function getTokenOrder(IERC20 quoteToken, IERC20 baseToken) internal pure returns (IERC20 token0, IERC20 token1) {
        return
            uint160(address(quoteToken)) < uint160(address(baseToken))
                ? (quoteToken, baseToken)
                : (baseToken, quoteToken);
    }
}
