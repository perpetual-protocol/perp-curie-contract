pragma solidity 0.7.6;
pragma abicoder v2;

import "../uniswap/Path.sol";
import "../lib/UniswapV3Broker.sol";
import "../interface/IMintableERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

contract TestUniswapV3Broker is IUniswapV3MintCallback, IUniswapV3SwapCallback {
    using Path for bytes;
    uint256 private constant DEFAULT_AMOUNT_IN_CACHED = type(uint256).max;
    uint256 private amountInCached = DEFAULT_AMOUNT_IN_CACHED;

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
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        // CallbackValidation.verifyCallback(_factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta));
        if (isExactInput) {
            IMintableERC20(tokenIn).mint(address(this), amountToPay);
            IMintableERC20(tokenIn).transfer(msg.sender, amountToPay);
        } else {
            amountInCached = amountToPay;
            tokenIn = tokenOut; // swap in/out because exact output swaps are reversed
            IMintableERC20(tokenIn).mint(address(this), amountToPay);
            IMintableERC20(tokenIn).transfer(msg.sender, amountToPay);
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
