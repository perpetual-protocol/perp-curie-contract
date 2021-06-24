pragma solidity 0.7.6;
pragma abicoder v2;

import "../lib/UniswapV3Broker.sol";
import "../interface/IMintableERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/libraries/Path.sol";

contract TestUniswapV3Broker is IUniswapV3MintCallback, IUniswapV3SwapCallback {
    using Path for bytes;

    address private _factory;

    constructor(address factory) {
        _factory = factory;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external override {
        // FIXME
        // MintCallbackData memory decoded = abi.decode(data, (MintCallbackData));
        // CallbackValidation.verifyCallback(_factory, decoded.poolKey);
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);

        if (amount0Owed > 0) {
            IMintableERC20(pool.token0()).mint(address(this), amount0Owed);
            IMintableERC20(pool.token0()).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IMintableERC20(pool.token1()).mint(address(this), amount1Owed);
            IMintableERC20(pool.token1()).transfer(msg.sender, amount1Owed);
        }
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0); // swaps entirely within 0-liquidity regions are not supported
        // FIXME
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenA, address tokenB, uint24 fee) = data.path.decodeFirstPool();
        // CallbackValidation.verifyCallback(_factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0 ? (tokenA < tokenB, uint256(amount0Delta)) : (tokenB < tokenA, uint256(amount1Delta));

        // isExactInput: 100 USDC (in) = tokenA -> ? ETH = tokenB
        // isExactOutput: ? USDC (in) = tokenB -> 0.1 ETH (out) = tokenA
        if (isExactInput) {
            // tokenA: tokenIn
            // tokenB: tokenOut
            IMintableERC20(tokenA).mint(address(this), amountToPay);
            IMintableERC20(tokenA).transfer(msg.sender, amountToPay);
        } else {
            // tokenA: tokenOut
            // tokenB: tokenIn
            IMintableERC20(tokenB).mint(address(this), amountToPay);
            IMintableERC20(tokenB).transfer(msg.sender, amountToPay);
        }
    }

    function mint(UniswapV3Broker.MintParams calldata params)
        external
        returns (UniswapV3Broker.MintResponse memory response)
    {
        return UniswapV3Broker.mint(params);
    }

    function burn(UniswapV3Broker.BurnParams calldata params)
        external
        returns (UniswapV3Broker.BurnResponse memory response)
    {
        return UniswapV3Broker.burn(params);
    }

    function swap(UniswapV3Broker.SwapParams calldata params)
        public
        returns (UniswapV3Broker.SwapResponse memory response)
    {
        return UniswapV3Broker.swap(params);
    }
}
