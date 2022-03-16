// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/libraries/Path.sol";
import "../lib/UniswapV3Broker.sol";
import "../interface/IERC20Metadata.sol";
import "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";

contract TestUniswapV3Broker is IUniswapV3MintCallback, IUniswapV3SwapCallback, Initializable {
    using Path for bytes;

    address private _factory;

    function initialize(address factory) external initializer {
        _factory = factory;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external override {
        // address baseToken = abi.decode(data, (address));
        // address pool = _poolMap[baseToken];
        // no data structure here; thus comment out
        address pool = msg.sender;
        // CH_FMV: failed mintCallback verification
        require(msg.sender == pool, "CH_FMV");

        if (amount0Owed > 0) {
            IERC20Metadata(IUniswapV3Pool(pool).token0()).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20Metadata(IUniswapV3Pool(pool).token1()).transfer(msg.sender, amount1Owed);
        }
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_ZIs: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        // address baseToken = abi.decode(data, (address));
        // address pool = _poolMap[baseToken];
        // no data structure here; thus comment out
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        // CH_FSV: failed swapCallback verification
        require(msg.sender == address(pool), "CH_FSV");

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));
        IERC20Metadata(token).transfer(msg.sender, amountToPay);
    }

    function addLiquidity(UniswapV3Broker.AddLiquidityParams calldata params)
        external
        returns (UniswapV3Broker.AddLiquidityResponse memory response)
    {
        return UniswapV3Broker.addLiquidity(params);
    }

    function removeLiquidity(UniswapV3Broker.RemoveLiquidityParams calldata params)
        external
        returns (UniswapV3Broker.RemoveLiquidityResponse memory response)
    {
        return UniswapV3Broker.removeLiquidity(params);
    }

    function swap(UniswapV3Broker.SwapParams calldata params)
        public
        returns (UniswapV3Broker.SwapResponse memory response)
    {
        return UniswapV3Broker.swap(params);
    }

    function getPositionKey(int24 lowerTick, int24 upperTick) external view returns (bytes32) {
        return PositionKey.compute(address(this), lowerTick, upperTick);
    }
}
